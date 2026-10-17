import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  RedisAdmission,
  admissionKeys,
  admitPurchase,
  initializeAdmission,
} from '../../packages/redis/src/index.js';
import { testServices } from '../services.js';

async function fixture() {
  const { redis, database } = testServices();

  await database.end();
  await redis.connect();

  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 2,
  };
  const keys = admissionKeys(sale.id);

  await redis.hSet(keys[0], {
    starts_at: String(Date.parse(sale.startsAt)),
    ends_at: String(Date.parse(sale.endsAt)),
    initial_stock: '2',
    remaining_stock: '2',
    configuration_version: '1',
  });

  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);

  return { redis, sale, keys, gate };
}

it('fences unreconciled sales, confirms replay/duplicates/lookup, and gates worker evidence', async () => {
  const f = await fixture();

  try {
    expect(
      await f.gate.place(f.sale.id, {
        identifier: 'person',
        idempotencyKey: 'key',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'confirming' });
    await f.gate.recover(f.sale, []);
    expect(
      await f.gate.place(f.sale.id, {
        identifier: 'person',
        idempotencyKey: 'key',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(
      await f.gate.place(f.sale.id, {
        identifier: 'PERSON',
        idempotencyKey: 'key',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(
      await f.gate.place(f.sale.id, {
        identifier: 'person',
        idempotencyKey: 'new',
      }),
    ).toEqual({
      status: 'REJECTED',
      reason: 'already_placed',
      existingOrder: { status: 'PROCESSING', phase: 'queued' },
    });

    const lookup = await f.gate.lookup(f.sale.id, ' Person ');

    expect(lookup.status).toBe('present');

    if (lookup.status !== 'present') throw new Error('Unconfirmed');

    await expect(
      f.gate.confirmForWorker(
        f.sale.id,
        'person',
        'key',
        lookup.reservation.streamId,
      ),
    ).resolves.toMatchObject({ requestKey: 'key' });
    await expect(
      f.gate.confirmForWorker(
        f.sale.id,
        'person',
        'other',
        lookup.reservation.streamId,
      ),
    ).rejects.toThrow('unconfirmed');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});
it('never treats missing lookup as rejection, including a delayed admission executing afterward', async () => {
  const f = await fixture();

  try {
    await f.gate.recover(f.sale, []);
    expect(await f.gate.lookup(f.sale.id, 'person')).toEqual({
      status: 'confirming',
      diagnostic: 'missing_without_absence_proof',
    });
    await f.gate.place(f.sale.id, {
      identifier: 'person',
      idempotencyKey: 'delayed',
    });
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('present');
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});
it('validates another connection reservation without advancing a durability checkpoint', async () => {
  const f = await fixture();

  try {
    await f.gate.recover(f.sale, []);
    await admitPurchase(f.redis, f.sale.id, {
      identifier: 'person',
      idempotencyKey: 'raw',
    });
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('present');
    expect(await f.redis.hGet(f.keys[0], 'confirmation_checkpoint')).toBeNull();
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});
it('recovery preserves pending stock and refuses mismatched DB orders or queue data', async () => {
  const f = await fixture();

  try {
    await f.gate.recover(f.sale, []);
    await admitPurchase(f.redis, f.sale.id, {
      identifier: 'person',
      idempotencyKey: 'pending',
    });
    await f.gate.recover(f.sale, []);
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    await expect(
      f.gate.recover(f.sale, [{ identifier: 'absent', admittedAtMs: 1 }]),
    ).rejects.toThrow('invalid accounting');
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe(
      'confirming',
    );
    await f.gate.recover(f.sale, []);
    await f.redis.del(f.keys[4]);
    await f.gate.recover(f.sale, []);
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('present');
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});
it('validates matching DB orders and refuses expiring allocation state', async () => {
  const f = await fixture();

  try {
    await f.gate.recover(f.sale, []);

    const result = await admitPurchase(f.redis, f.sale.id, {
      identifier: 'person',
      idempotencyKey: 'key',
    });

    if (result.status !== 'reserved') throw new Error('Missing reservation');

    await f.gate.recover(f.sale, [
      { identifier: 'person', admittedAtMs: result.reservation.admittedAtMs },
    ]);
    await f.redis.pExpire(f.keys[3], 60000);
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe(
      'confirming',
    );
    await expect(f.gate.recover(f.sale, [])).rejects.toThrow(
      'invalid accounting',
    );
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});

it('keeps a validated epoch visible while another replica prepares recovery', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const peer = new RedisAdmission(
    process.env.TEST_REDIS_URL!,
    16,
    10000,
    async (boundary) => {
      if (boundary === 'before_recovery') {
        entered();
        await resume;
      }
    },
  );
  let recovery: Promise<void> | undefined;

  try {
    await f.gate.recover(f.sale, []);
    expect(
      await f.gate.place(f.sale.id, {
        identifier: 'person',
        idempotencyKey: 'key',
      }),
    ).toMatchObject({ phase: 'queued' });

    const epoch = await f.redis.hGet(f.keys[0], 'recovered_run');

    recovery = peer.recover(f.sale, []);
    await paused;
    expect(await f.redis.hGet(f.keys[0], 'recovered_run')).toBe(epoch);
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('present');
    release();
    await recovery;
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
    expect(await f.redis.hGet(f.keys[0], 'admission_fault')).toBeNull();
  } finally {
    release();
    await recovery;
    peer.close();
    f.gate.close();
    f.redis.destroy();
  }
}, 15000);

it('fences configuration mismatches atomically without releasing reservations', async () => {
  const f = await fixture();

  try {
    await f.gate.recover(f.sale, []);
    await f.gate.place(f.sale.id, {
      identifier: 'person',
      idempotencyKey: 'key',
    });
    await expect(
      f.gate.recover({ ...f.sale, initialStock: 3 }, []),
    ).rejects.toThrow();
    expect(await f.redis.hGet(f.keys[0], 'recovered_run')).toBeNull();
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe(
      'confirming',
    );
    await f.gate.recover(f.sale, []);
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('present');
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});

it('leaves missing pre-sale state configurable after a failed reconciliation', async () => {
  const f = await fixture();
  const sale = {
    ...f.sale,
    id: randomUUID(),
    startsAt: new Date(Date.now() + 60000).toISOString(),
    endsAt: new Date(Date.now() + 120000).toISOString(),
  };
  const key = admissionKeys(sale.id)[0];

  try {
    await expect(f.gate.recover(sale, [])).rejects.toThrow(
      'invalid accounting',
    );
    expect(await f.redis.exists(key)).toBe(0);
    await initializeAdmission(f.redis, sale);
    await f.gate.recover(sale, []);
    expect(await f.redis.hGet(key, 'recovered_run')).not.toBeNull();
    expect(await f.redis.hGet(key, 'remaining_stock')).toBe('2');
  } finally {
    f.gate.close();
    f.redis.destroy();
  }
});
