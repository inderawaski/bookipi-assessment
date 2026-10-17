import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  admissionKeys,
  admitPurchase,
  AdmissionUncertainError,
  createRedisConnection,
} from '../../packages/redis/src/index.js';
import {
  admissionScript,
  admissionWindowPredicate,
} from '../../packages/redis/src/sales/admission-script.js';
import { testServices } from '../services.js';

// Test fixtures seed Redis state directly; production admission always reads Redis TIME.
async function fixture(
  stock = 1,
  window: 'open' | 'upcoming' | 'ended' = 'open',
) {
  const { redis, database } = testServices();

  await database.end();
  await redis.connect();

  const sale = randomUUID();
  const keys = admissionKeys(sale);
  const time = (await redis.sendCommand(['TIME'])) as string[];
  const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);

  await redis.hSet(keys[0], {
    recovered_run: (await redis.info('server')).match(/run_id:([^\r\n]+)/)![1]!,
    configuration_version: '1',
    starts_at: String(window === 'upcoming' ? now + 3600000 : now - 3600000),
    ends_at: String(window === 'ended' ? now - 1 : now + 7200000),
    initial_stock: String(stock),
    remaining_stock: String(stock),
  });

  return {
    redis,
    sale,
    keys,
    place: (identifier: string, idempotencyKey: string = randomUUID()) =>
      admitPurchase(redis, sale, { identifier, idempotencyKey }),
  };
}

it('allocates the last unit once across independent connections and preserves fairness evidence', async () => {
  const f = await fixture();
  const second = createRedisConnection(process.env.TEST_REDIS_URL!, 'commands');

  await second.connect();

  try {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        admitPurchase(i % 2 ? second : f.redis, f.sale, {
          identifier: `person-${i}`,
          idempotencyKey: `key-${i}`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'reserved')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected' && r.reason === 'sold_out'),
    ).toHaveLength(99);
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('0');
    expect(await f.redis.hLen(f.keys[1])).toBe(1);
    expect(await f.redis.hLen(f.keys[2])).toBe(1);
    expect(await f.redis.hLen(f.keys[3])).toBe(1);

    const entries = await f.redis.xRange(f.keys[4], '-', '+');

    if (!entries) throw new Error('Missing stream');

    expect(entries).toHaveLength(1);

    const reserved = results.find((r) => r.status === 'reserved');

    expect(reserved?.reservation.streamId).toBe(entries[0]?.id);
    expect(reserved?.reservation.admittedAtMs).toBe(
      Number(entries[0]?.message.admitted_at_ms),
    );

    for (const key of f.keys) expect(await f.redis.pTTL(key)).toBe(-1);
  } finally {
    second.destroy();
    f.redis.destroy();
  }
});

it('allocates mixed-case identifiers once, detects key conflicts and replays after closing', async () => {
  const f = await fixture(100);
  const second = createRedisConnection(process.env.TEST_REDIS_URL!, 'commands');

  await second.connect();

  try {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        admitPurchase(i % 2 ? second : f.redis, f.sale, {
          identifier: i % 2 ? ' Person ' : 'PERSON',
          idempotencyKey: `key-${i}`,
        }),
      ),
    );
    const first = results.find((r) => r.status === 'reserved');

    expect(first?.status).toBe('reserved');

    if (first?.status !== 'reserved') throw new Error('Missing reservation');

    expect(results.filter((r) => r.status === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'already_placed')).toHaveLength(
      99,
    );

    const key = first.reservation.requestKey;
    const replays = await Promise.all(
      Array.from({ length: 50 }, () => f.place('PERSON', key)),
    );

    expect(replays.every((r) => r.status === 'reserved' && r.replay)).toBe(
      true,
    );
    await f.redis.hSet(
      f.keys[0],
      'ends_at',
      String(first.reservation.admittedAtMs),
    );
    expect(await f.place(' person ', key)).toEqual({ ...first, replay: true });
    expect(await f.place('other', key)).toEqual({
      status: 'rejected',
      reason: 'idempotency_conflict',
    });
    expect(await f.place('person')).toEqual({
      status: 'already_placed',
      reservation: first.reservation,
    });
    expect(await f.place('other')).toEqual({
      status: 'rejected',
      reason: 'ended',
    });
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('99');
  } finally {
    second.destroy();
    f.redis.destroy();
  }
});

it('records monotonic stream execution order in a concurrent admitted batch', async () => {
  const f = await fixture(100);

  try {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        f.place(`person-${i}`, `request-${i}`),
      ),
    );

    expect(results.every((r) => r.status === 'reserved')).toBe(true);

    const entries = await f.redis.xRange(f.keys[4], '-', '+');

    if (!entries) throw new Error('Missing stream');

    expect(entries).toHaveLength(100);

    for (let i = 1; i < entries.length; i++)
      expect(Number(entries[i]!.message.admitted_at_ms)).toBeGreaterThanOrEqual(
        Number(entries[i - 1]!.message.admitted_at_ms),
      );

    for (const result of results) {
      if (result.status !== 'reserved') throw new Error('Missing reservation');

      expect(
        entries.find((e) => e.id === result.reservation.streamId)?.message
          .request_key,
      ).toBe(result.reservation.requestKey);
    }
  } finally {
    f.redis.destroy();
  }
});

it.each(['upcoming', 'ended', 'sold_out'] as const)(
  'retains %s outcomes without allocating stock',
  async (reason) => {
    const f = await fixture(
      reason === 'sold_out' ? 0 : 1,
      reason === 'sold_out' ? 'open' : reason,
    );

    try {
      expect(await f.place('person', 'retry')).toEqual({
        status: 'rejected',
        reason,
      });

      for (const key of f.keys.slice(1))
        expect(await f.redis.exists(key)).toBe(0);

      expect(await f.place('different', 'retry')).toEqual({
        status: 'rejected',
        reason: 'idempotency_conflict',
      });

      // Opening the window cannot change the original request outcome.
      if (reason === 'upcoming') {
        await f.redis.hSet(f.keys[0], 'starts_at', '1');
        expect(await f.place('person', 'retry')).toEqual({
          status: 'rejected',
          reason: 'upcoming',
        });
        expect((await f.place('person', 'new-request')).status).toBe(
          'reserved',
        );
      }
    } finally {
      f.redis.destroy();
    }
  },
);

it.each([0, 1, 2, 3, 4])(
  'rejects incorrect key type at position %i before mutation',
  async (position) => {
    const f = await fixture();

    try {
      await f.redis.del(f.keys[position]!);
      await f.redis.set(f.keys[position]!, 'wrong');

      const before = await Promise.all(f.keys.map((key) => f.redis.dump(key)));

      await expect(f.place('person')).rejects.toBeInstanceOf(
        AdmissionUncertainError,
      );
      expect(await Promise.all(f.keys.map((key) => f.redis.dump(key)))).toEqual(
        before,
      );
    } finally {
      f.redis.destroy();
    }
  },
);

it.each(['-1', '01', 'abc', '2', '9007199254740992'])(
  'rejects invalid remaining stock %s without mutation',
  async (remaining) => {
    const f = await fixture();

    try {
      await f.redis.hSet(f.keys[0], 'remaining_stock', remaining);
      await expect(f.place('person')).rejects.toThrow('uncertain');
      expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe(remaining);
      expect(await f.redis.exists(f.keys[4])).toBe(0);
    } finally {
      f.redis.destroy();
    }
  },
);

it('validates direct script arguments, aliased keys, expired state and exhausted streams before mutation', async () => {
  const f = await fixture();

  try {
    for (const args of [
      ['', 'key', f.sale],
      ['person', 'bad key', f.sale],
      ['person'],
    ]) {
      await expect(
        f.redis.sendCommand(['EVAL', admissionScript, '5', ...f.keys, ...args]),
      ).rejects.toThrow('ADMISSION_SCHEMA');
    }

    await expect(
      f.redis.sendCommand([
        'EVAL',
        admissionScript,
        '5',
        ...Array<string>(5).fill(f.keys[0]),
        'person',
        'key',
        f.sale,
      ]),
    ).rejects.toThrow('aliased');
    await f.redis.pExpire(f.keys[0], 3600000);
    await expect(f.place('person')).rejects.toThrow('uncertain');
    await f.redis.persist(f.keys[0]);
    await f.redis.sendCommand([
      'XADD',
      f.keys[4],
      '18446744073709551615-18446744073709551615',
      'test',
      'exhausted',
    ]);
    await expect(f.place('person')).rejects.toThrow('uncertain');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    expect(await f.redis.hLen(f.keys[1])).toBe(0);
  } finally {
    f.redis.destroy();
  }
});

it('latches an unexpected post-mutation error and blocks replay/new admission for reconciliation', async () => {
  const f = await fixture(2);

  try {
    // Inject only into the test copy, at the exact mutation boundary. No production test switch.
    const fault = admissionScript.replace(
      "local sequence = redis.call('XADD'",
      "error('injected fault')\n  local sequence = redis.call('XADD'",
    );

    await expect(
      f.redis.sendCommand([
        'EVAL',
        fault,
        '5',
        ...f.keys,
        'person',
        'key',
        f.sale,
      ]),
    ).rejects.toThrow('ADMISSION_UNCERTAIN');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    expect(await f.redis.hGet(f.keys[0], 'admission_fault')).toBe('key');
    await expect(f.place('person', 'key')).rejects.toThrow('uncertain');
    await expect(f.place('other')).rejects.toThrow('uncertain');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
  } finally {
    f.redis.destroy();
  }
});

it('collapses simultaneous delivery of one request into one reservation and stream append', async () => {
  const f = await fixture(10);

  try {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => f.place('person', 'same-key')),
    );

    expect(
      results.filter((r) => r.status === 'reserved' && !r.replay),
    ).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'reserved' && r.replay),
    ).toHaveLength(99);
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('9');
  } finally {
    f.redis.destroy();
  }
});

it('fails closed on missing configuration or broken allocation associations', async () => {
  const f = await fixture(2);

  try {
    await f.redis.hDel(f.keys[0], 'ends_at');
    await expect(f.place('person')).rejects.toThrow('uncertain');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('2');
    await f.redis.hSet(f.keys[0], 'ends_at', '9007199254740991');
    await f.place('person', 'key');
    await f.redis.hSet(f.keys[1], 'person', 'different-key');
    await expect(f.place('person', 'key')).rejects.toThrow('uncertain');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    await f.redis.del(f.keys[2]);
    await expect(f.place('other')).rejects.toThrow('uncertain');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
  } finally {
    f.redis.destroy();
  }
});

it('evaluates exact opening and closing boundaries with the production Lua predicate', async () => {
  const f = await fixture();

  try {
    const script =
      admissionWindowPredicate +
      "return windowRejection(tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])) or 'open'";
    const results = await Promise.all(
      [99, 100, 199, 200].map((now) =>
        f.redis.sendCommand(['EVAL', script, '0', '100', '200', String(now)]),
      ),
    );

    expect(results).toEqual(['upcoming', 'open', 'open', 'ended']);
  } finally {
    f.redis.destroy();
  }
});
