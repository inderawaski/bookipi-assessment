import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  migrate,
  persistSale,
  persistOrder,
} from '../../packages/database/src/index.js';
import {
  RedisAdmission,
  admissionKeys,
  assertAdmissionConfiguration,
} from '../../packages/redis/dist/index.js';
import { createHealthServer } from '../../apps/api/src/health.js';
import { registerSaleRoutes } from '../../apps/api/src/sales/routes.js';
import { testServices } from '../services.js';

it('exposes real admission, normalization, retries, delayed state and committed orders', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  const admission = new RedisAdmission(process.env.TEST_REDIS_URL!);
  const probe = async () => {
    await database.query('SELECT 1');
    await assertAdmissionConfiguration(redis, sale);
  };
  const app = createHealthServer(probe);
  registerSaleRoutes(app, {
    configurationScope: '/flash_test',
    database,
    redis,
    admission,
    probe,
  });
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
    await admission.recover(sale, []);
    const base = `/sales/${sale.id}`;
    const submit = (identifier: string, idempotencyKey: string) =>
      app.inject({
        method: 'POST',
        url: `${base}/purchases`,
        payload: { identifier, idempotencyKey },
      });
    expect(
      (await app.inject(`${base}/order?identifier=Person`)).json(),
    ).toEqual({ status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } });
    expect((await submit(' Person ', 'key')).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    // Discard the first response and retry the same logical request.
    expect((await submit('PERSON', 'key')).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect((await submit('person', 'new-key')).json()).toEqual({
      status: 'REJECTED',
      reason: 'already_placed',
      existingOrder: { status: 'PROCESSING', phase: 'queued' },
    });
    expect((await submit('other', 'key')).json()).toEqual({
      status: 'REJECTED',
      reason: 'idempotency_conflict',
    });
    expect((await submit('other', 'other-key')).json()).toEqual({
      status: 'REJECTED',
      reason: 'sold_out',
    });
    expect(await redis.xLen(keys[4])).toBe(1);
    const confirmation = await admission.lookup(sale.id, 'person');
    expect(confirmation.status).toBe('present');
    if (confirmation.status !== 'present') throw new Error('Missing admission');
    await redis.hSet(
      `${keys[0]}:retries`,
      confirmation.reservation.streamId,
      JSON.stringify({
        version: 1,
        attempts: 1,
        nextAt: 0,
        reason: 'dependency_unavailable',
        exhausted: false,
      }),
    );
    expect(
      (await app.inject(`${base}/order?identifier=PERSON`)).json(),
    ).toEqual({
      status: 'AVAILABLE',
      order: { status: 'PROCESSING', phase: 'delayed' },
    });
    const orderId = await persistOrder(database, {
      saleId: sale.id,
      identifier: 'person',
      admittedAtMs: confirmation.reservation.admittedAtMs,
    });
    expect((await submit('person', 'key')).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect((await submit('person', 'newest-key')).json()).toEqual({
      status: 'REJECTED',
      reason: 'already_placed',
      existingOrder: { status: 'PROCESSING', phase: 'queued' },
    });
    await redis.hDel(keys[0], 'recovered_run');
    expect(
      (await app.inject(`${base}/order?identifier=unknown`)).statusCode,
    ).toBe(503);
    expect(
      (await app.inject(`${base}/order?identifier=person`)).json(),
    ).toEqual({ status: 'AVAILABLE', order: { status: 'SUCCESS', orderId } });
    redis.destroy();
    expect(
      (await app.inject(`${base}/order?identifier=person`)).json(),
    ).toEqual({ status: 'AVAILABLE', order: { status: 'SUCCESS', orderId } });
    expect(
      (await app.inject(`${base}/order?identifier=unknown`)).statusCode,
    ).toBe(503);
    await database.end();
    expect(
      (await app.inject(`${base}/order?identifier=person`)).json(),
    ).toEqual({ status: 'UNAVAILABLE', reason: 'unavailable' });
  } finally {
    admission.close();
    await app.close();
    if (redis.isOpen) redis.destroy();
    if (!database.ended) await database.end();
  }
}, 30000);
it('replays an admitted result after closing and distinguishes upcoming and ended', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const admission = new RedisAdmission(process.env.TEST_REDIS_URL!);
  const app = createHealthServer(async () => {});
  registerSaleRoutes(app, {
    configurationScope: '/flash_test',
    database,
    redis,
    admission,
    probe: async () => {
      await database.query('SELECT 1');
    },
  });
  try {
    await migrate(database);
    const id = randomUUID();
    const start = Date.now() + 2000,
      end = start + 2000;
    const sale = {
      id,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      initialStock: 1,
    };
    await persistSale(database, sale);
    const keys = admissionKeys(id);
    await redis.hSet(keys[0], {
      starts_at: String(start),
      ends_at: String(end),
      initial_stock: '1',
      remaining_stock: '1',
      configuration_version: '1',
    });
    await admission.recover(sale, []);
    const post = (key: string) =>
      app.inject({
        method: 'POST',
        url: `/sales/${id}/purchases`,
        payload: { identifier: 'person', idempotencyKey: key },
      });
    expect((await post('early')).json()).toEqual({
      status: 'REJECTED',
      reason: 'upcoming',
    });
    await expect
      .poll(
        async () => {
          const time = (await redis.sendCommand(['TIME'])) as string[];
          return (
            Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) >= start
          );
        },
        { timeout: 5000, interval: 25 },
      )
      .toBe(true);
    expect((await post('accepted')).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    await expect
      .poll(
        async () => {
          const time = (await redis.sendCommand(['TIME'])) as string[];
          return (
            Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) >= end
          );
        },
        { timeout: 5000, interval: 25 },
      )
      .toBe(true);
    expect((await post('accepted')).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect((await post('early')).json()).toEqual({
      status: 'REJECTED',
      reason: 'upcoming',
    });
    expect((await app.inject(`/sales/${id}`)).json()).toMatchObject({
      status: 'ENDED',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/sales/${id}/purchases`,
          payload: { identifier: 'other', idempotencyKey: 'late' },
        })
      ).json(),
    ).toEqual({ status: 'REJECTED', reason: 'ended' });
    expect(await redis.xLen(keys[4])).toBe(1);
  } finally {
    admission.close();
    await app.close();
    redis.destroy();
    await database.end();
  }
}, 20000);

it('exposes unconfirmed admission as retryable NOT_ORDERED without losing or duplicating its allocation', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  let loseConfirmation = false;
  const admission = new RedisAdmission(
    process.env.TEST_REDIS_URL!,
    16,
    3000,
    async (boundary) => {
      if (
        loseConfirmation &&
        (boundary === 'after_send' || boundary === 'before_lookup')
      )
        throw new Error('Injected confirmation loss');
    },
  );
  const app = createHealthServer(async () => {});
  registerSaleRoutes(app, {
    configurationScope: '/flash_test',
    database,
    redis,
    admission,
    probe: async () => {
      await database.query('SELECT 1');
    },
  });
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
    await admission.recover(sale, []);
    loseConfirmation = true;
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/sales/${sale.id}/purchases`,
        payload: { identifier: 'person', idempotencyKey: 'same-key' },
      });
    expect((await post()).json()).toEqual({
      status: 'NOT_ORDERED',
      reason: 'confirmation_uncertain',
    });
    expect(
      (await app.inject(`/sales/${sale.id}/order?identifier=person`)).json(),
    ).toEqual({
      status: 'AVAILABLE',
      order: { status: 'NOT_ORDERED', reason: 'confirmation_uncertain' },
    });
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    loseConfirmation = false;
    expect((await post()).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hLen(keys[3])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
  } finally {
    admission.close();
    await app.close();
    redis.destroy();
    await database.end();
  }
}, 20000);

it('admits from preloaded Redis configuration during a PostgreSQL outage and retains Lua fences', async () => {
  const { database, redis } = testServices();
  const admission = new RedisAdmission(process.env.TEST_REDIS_URL!);
  const probe = async () => {
    await database.query('SELECT 1');
  };
  const app = createHealthServer(probe);
  registerSaleRoutes(app, {
    configurationScope: '/flash_test',
    database,
    redis,
    admission,
    probe,
  });
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  const keys = admissionKeys(sale.id);
  const post = (identifier = 'person', key = 'key', saleId = sale.id) =>
    app.inject({
      method: 'POST',
      url: `/sales/${saleId}/purchases`,
      payload: { identifier, idempotencyKey: key },
    });
  try {
    await migrate(database);
    await persistSale(database, sale);
    await redis.connect();
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '1',
      remaining_stock: '1',
      configuration_version: '1',
    });
    await admission.recover(sale, []);
    // The same pool used by both the route and its readiness probe is unavailable.
    await database.end();
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    expect((await post()).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect((await post()).json()).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect((await post('other', 'other-key')).json()).toEqual({
      status: 'REJECTED',
      reason: 'sold_out',
    });
    expect((await post('other')).json()).toEqual({
      status: 'REJECTED',
      reason: 'idempotency_conflict',
    });
    expect((await post('person', 'new-key')).json()).toEqual({
      status: 'REJECTED',
      reason: 'already_placed',
      existingOrder: { status: 'PROCESSING', phase: 'queued' },
    });
    expect(
      (await app.inject(`/sales/${sale.id}/order?identifier=person`))
        .statusCode,
    ).toBe(503);
    const uncertain = {
      status: 'NOT_ORDERED',
      reason: 'confirmation_uncertain',
    };
    // Never rebuild missing or invalid configuration from a request.
    expect((await post('unknown', 'missing-key', randomUUID())).json()).toEqual(
      uncertain,
    );
    await redis.hSet(keys[0], 'configuration_version', 'broken');
    expect((await post('corrupt', 'corrupt-key')).json()).toEqual(uncertain);
    await redis.hSet(keys[0], 'configuration_version', '1');
    await redis.hSet(keys[0], 'admission_fault', 'operator repair required');
    expect((await post('fault', 'fault-key')).json()).toEqual(uncertain);
    await redis.hDel(keys[0], 'admission_fault');
    // A restarted primary has a different run ID; a stale epoch must fence even replay.
    await redis.hSet(keys[0], 'recovered_run', 'previous-primary-run');
    expect((await post()).json()).toEqual(uncertain);
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
  } finally {
    admission.close();
    await app.close();
    if (redis.isOpen) redis.destroy();
    if (!database.ended) await database.end();
  }
}, 20000);
