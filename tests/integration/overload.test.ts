import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { migrate, persistSale } from '../../packages/database/src/index.js';
import {
  RedisAdmission,
  admissionKeys,
  assertAdmissionConfiguration,
} from '../../packages/redis/dist/index.js';
import { createHealthServer } from '../../apps/api/src/health.js';
import { registerSaleRoutes } from '../../apps/api/src/sales/routes.js';
import { testServices } from '../services.js';

it('shares last stock and duplicate mappings across independently bounded API instances', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  const apps = [
    createHealthServer(async () => {}),
    createHealthServer(async () => {}),
  ];
  const admissions = apps.map(
    () => new RedisAdmission(process.env.TEST_REDIS_URL!, 2),
  );
  try {
    await migrate(database);
    await persistSale(database, sale);
    const keys = admissionKeys(sale.id);
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '1',
      remaining_stock: '1',
      configuration_version: '1',
    });
    await admissions[0]!.recover(sale, []);
    apps.forEach((app, i) =>
      registerSaleRoutes(app, {
        configurationScope: '/flash_test',
        database,
        redis,
        admission: admissions[i]!,
        probe: async () => {},
      }),
    );
    const submit = (i: number, identifier: string, idempotencyKey: string) =>
      apps[i]!.inject({
        method: 'POST',
        url: `/sales/${sale.id}/purchases`,
        payload: { identifier, idempotencyKey },
      });
    const results = await Promise.all([
      submit(0, 'first', 'first'),
      submit(1, 'second', 'second'),
    ]);
    expect(results.map((r) => r.json().status).sort()).toEqual([
      'PROCESSING',
      'REJECTED',
    ]);
    const winner =
      results[0]!.json().status === 'PROCESSING' ? 'first' : 'second';
    expect((await submit(1, winner, winner)).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect((await submit(0, winner, 'new')).json()).toMatchObject({
      status: 'REJECTED',
      reason: 'already_placed',
    });
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    await assertAdmissionConfiguration(redis, sale);
    expect(await redis.configGet(['appendfsync'])).toEqual({
      appendfsync: 'everysec',
    });
  } finally {
    admissions.forEach((admission) => admission.close());
    await Promise.all(apps.map((app) => app.close()));
    redis.destroy();
    await database.end();
  }
}, 30000);

it('waits for an occupied admission connection and admits both buyers without losing work', async () => {
  const { redis, database } = testServices();
  await redis.connect();
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 2,
  };
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!, 1);
  const keys = admissionKeys(sale.id);
  try {
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '2',
      remaining_stock: '2',
      configuration_version: '1',
    });
    await gate.recover(sale, []);
    const first = gate.place(sale.id, {
      identifier: 'first',
      idempotencyKey: 'first',
    });
    expect(
      await gate.place(sale.id, {
        identifier: 'second',
        idempotencyKey: 'second',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await first).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(2); // worker outage retains a bounded-by-stock backlog
    expect(
      await gate.place(sale.id, {
        identifier: 'second',
        idempotencyKey: 'second',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(2);
    expect(await redis.configGet(['appendfsync'])).toEqual({
      appendfsync: 'everysec',
    });
  } finally {
    gate.close();
    redis.destroy();
    await database.end();
  }
}, 15000);

it('admits without waiting for an exhausted database pool', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
  const app = createHealthServer(async () => {});
  registerSaleRoutes(app, {
    configurationScope: '/flash_test',
    database,
    redis,
    admission: gate,
    probe: async () => {},
  });
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  const keys = admissionKeys(sale.id);
  await redis.hSet(keys[0], {
    starts_at: String(Date.parse(sale.startsAt)),
    ends_at: String(Date.parse(sale.endsAt)),
    initial_stock: '1',
    remaining_stock: '1',
    configuration_version: '1',
  });
  await gate.recover(sale, []);
  const clients = await Promise.all([database.connect(), database.connect()]);
  try {
    const id = sale.id;
    const result = await app.inject({
      method: 'POST',
      url: `/sales/${id}/purchases`,
      payload: { identifier: 'person', idempotencyKey: 'key' },
    });
    expect(result.json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(database.waitingCount).toBe(0);
    expect(await redis.xLen(keys[4])).toBe(1);
  } finally {
    gate.close();
    clients.forEach((client) => client.release());
    await app.close();
    redis.destroy();
    await database.end();
  }
}, 10000);

it('expires a queued purchase before Lua without binding its key or reserving stock', async () => {
  const { redis, database } = testServices();
  let hold = false,
    started!: () => void,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = new RedisAdmission(
    process.env.TEST_REDIS_URL!,
    1,
    10000,
    async (boundary) => {
      if (hold && boundary === 'before_send') {
        hold = false;
        started();
        await blocked;
      }
    },
  );
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 2,
  };
  const keys = admissionKeys(sale.id);
  let first: ReturnType<typeof gate.place> | undefined;
  try {
    await redis.connect();
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '2',
      remaining_stock: '2',
      configuration_version: '1',
    });
    await gate.recover(sale, []);
    hold = true;
    first = gate.place(sale.id, {
      identifier: 'first',
      idempotencyKey: 'first',
    });
    await ready;
    expect(
      await gate.place(sale.id, {
        identifier: 'waiting',
        idempotencyKey: 'waiting',
      }),
    ).toEqual({ status: 'REJECTED', reason: 'busy' });
    release();
    expect(await first).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hExists(keys[2], 'waiting')).toBe(0);
    expect(await redis.hExists(`${keys[0]}:outcomes`, 'waiting')).toBe(0);
    // The timed-out key remains safe to retry as a fresh admission.
    expect(
      await gate.place(sale.id, {
        identifier: 'waiting',
        idempotencyKey: 'waiting',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(2);
  } finally {
    release();
    await first?.catch(() => {});
    gate.close();
    if (redis.isOpen) redis.destroy();
    await database.end();
  }
});

it('waits beyond the former 10-ms limit and hands off queued purchases in order', async () => {
  const { redis, database } = testServices();
  let hold = false,
    started!: () => void,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = new RedisAdmission(
    process.env.TEST_REDIS_URL!,
    1,
    3000,
    async (boundary) => {
      if (hold && boundary === 'before_send') {
        hold = false;
        started();
        await blocked;
      }
    },
  );
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 3,
  };
  const keys = admissionKeys(sale.id);
  const purchases: ReturnType<typeof gate.place>[] = [];
  try {
    await redis.connect();
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '3',
      remaining_stock: '3',
      configuration_version: '1',
    });
    await gate.recover(sale, []);
    hold = true;
    purchases.push(
      gate.place(sale.id, { identifier: 'first', idempotencyKey: 'first' }),
    );
    await ready;
    purchases.push(
      gate.place(sale.id, { identifier: 'second', idempotencyKey: 'second' }),
    );
    purchases.push(
      gate.place(sale.id, { identifier: 'third', idempotencyKey: 'third' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect(await Promise.all(purchases)).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 'PROCESSING',
        phase: 'queued',
      })),
    );
    const entries = await redis.xRange(keys[4], '-', '+');
    expect(entries?.map((entry) => entry.message.identifier)).toEqual([
      'first',
      'second',
      'third',
    ]);
  } finally {
    release();
    await Promise.allSettled(purchases);
    gate.close();
    if (redis.isOpen) redis.destroy();
    await database.end();
  }
});

it('prevents a timed-out operation sending after its leased client reconnects', async () => {
  const { redis, database } = testServices();
  let hold = false,
    started!: () => void,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = new RedisAdmission(
    process.env.TEST_REDIS_URL!,
    1,
    100,
    async (boundary) => {
      if (hold && boundary === 'before_send') {
        hold = false;
        started();
        await blocked;
      }
    },
  );
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 2,
  };
  const keys = admissionKeys(sale.id);
  try {
    await redis.connect();
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '2',
      remaining_stock: '2',
      configuration_version: '1',
    });
    await gate.recover(sale, []);
    hold = true;
    const expired = gate.place(sale.id, {
      identifier: 'expired',
      idempotencyKey: 'expired',
    });
    await ready;
    expect(await expired).toEqual({
      status: 'PROCESSING',
      phase: 'confirming',
    });
    expect(
      await gate.place(sale.id, { identifier: 'next', idempotencyKey: 'next' }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hExists(keys[2], 'expired')).toBe(0);
    expect(
      await gate.place(sale.id, { identifier: 'last', idempotencyKey: 'last' }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
  } finally {
    release();
    gate.close();
    if (redis.isOpen) redis.destroy();
    await database.end();
  }
});

it('releases the purchase lease before post-reply processing completes', async () => {
  const { redis, database } = testServices();
  let hold = false,
    started!: () => void,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = new RedisAdmission(
    process.env.TEST_REDIS_URL!,
    1,
    3000,
    async (boundary) => {
      if (hold && boundary === 'after_send') {
        hold = false;
        started();
        await blocked;
      }
    },
  );
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 2,
  };
  const keys = admissionKeys(sale.id);
  let first: ReturnType<typeof gate.place> | undefined;
  try {
    await redis.connect();
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '2',
      remaining_stock: '2',
      configuration_version: '1',
    });
    await gate.recover(sale, []);
    hold = true;
    first = gate.place(sale.id, {
      identifier: 'first',
      idempotencyKey: 'first',
    });
    await ready;
    // Post-reply work is paused, but the only connection is available to the second buyer.
    expect(
      await gate.place(sale.id, {
        identifier: 'second',
        idempotencyKey: 'second',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    release();
    expect(await first).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(2);
  } finally {
    release();
    await first?.catch(() => {});
    gate.close();
    if (redis.isOpen) redis.destroy();
    await database.end();
  }
});
