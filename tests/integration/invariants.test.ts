import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { migrate, persistSale } from '../../packages/database/src/index.js';
import {
  RedisAdmission,
  admissionKeys,
  initializeAdmission,
} from '../../packages/redis/dist/index.js';
import { createHealthServer } from '../../apps/api/src/health.js';
import { registerSaleRoutes } from '../../apps/api/src/sales/routes.js';
import {
  createOrderConsumer,
  orderGroup,
} from '../../apps/worker/src/orders/consumer.js';
import { testServices } from '../services.js';

it('accounts independently for acknowledged admissions across two APIs and workers after closing and recovery', async () => {
  const { database, redis } = testServices();
  const apps = [
    createHealthServer(async () => {}),
    createHealthServer(async () => {}),
  ];
  const gates = apps.map(() => new RedisAdmission(process.env.TEST_REDIS_URL!));
  const stops: (() => Promise<void>)[] = [];
  const errors: string[] = [];
  try {
    await redis.connect();
    await migrate(database);
    const clock = (await redis.sendCommand(['TIME'])) as string[];
    const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
    const sale = {
      id: randomUUID(),
      startsAt: new Date(now + 3000).toISOString(),
      endsAt: new Date(now + 12000).toISOString(),
      initialStock: 8,
    };
    await persistSale(database, sale);
    await initializeAdmission(redis, sale);
    await gates[0]!.recover(sale, []);
    apps.forEach((app, i) =>
      registerSaleRoutes(app, {
        configurationScope: '/flash_test',
        database,
        redis,
        admission: gates[i]!,
        probe: async () => {
          await database.query('SELECT 1');
        },
      }),
    );
    const post = async (
      i: number,
      identifier: string,
      key: string,
      id = sale.id,
    ) =>
      (
        await apps[i % 2]!.inject({
          method: 'POST',
          url: `/sales/${id}/purchases`,
          payload: { identifier, idempotencyKey: key },
        })
      ).json();
    expect(await post(0, 'person', 'unknown', randomUUID())).toEqual({
      status: 'NOT_ORDERED',
      reason: 'confirmation_uncertain',
    });
    // Poll Redis TIME, rather than sleeping until the API host believes the sale is open.
    await expect
      .poll(
        async () => {
          const t = (await redis.sendCommand(['TIME'])) as string[];
          return (
            Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) >=
            Date.parse(sale.startsAt)
          );
        },
        { timeout: 6000, interval: 25 },
      )
      .toBe(true);
    // Client/API time can disagree; admission still uses Redis TIME.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 86400000);
    try {
      expect(await post(0, ' First ', 'first')).toEqual({
        status: 'PROCESSING',
        phase: 'queued',
      });
    } finally {
      spy.mockRestore();
    }
    // Sequential primary acknowledgements establish an authoritative prefix before contention.
    expect(await post(1, 'second', 'second')).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    const inputs = Array.from({ length: 24 }, (_, i) => ({
      identifier: ` Person-${i % 12} `,
      key: `request-${i}`,
    }));
    const responses = await Promise.all(
      inputs.map((input, i) => post(i, input.identifier, input.key)),
    );
    const acknowledged = new Set(['first', 'second']);
    responses.forEach((response, i) => {
      if (response.status === 'PROCESSING' && response.phase === 'queued')
        acknowledged.add(inputs[i]!.identifier.trim().toLowerCase());
    });
    const keys = admissionKeys(sale.id);
    const entries = (await redis.xRange(keys[4], '-', '+'))!;
    const allocations = await redis.hGetAll(keys[1]);
    expect(entries.length).toBeLessThanOrEqual(sale.initialStock);
    expect(entries).toHaveLength(sale.initialStock);
    expect(new Set(entries.map((e) => e.message.identifier)).size).toBe(
      entries.length,
    );
    expect(new Set(entries.map((e) => e.message.request_key)).size).toBe(
      entries.length,
    );
    expect(Object.keys(allocations).sort()).toEqual(
      entries.map((e) => e.message.identifier).sort(),
    );
    expect([...acknowledged].sort()).toEqual(Object.keys(allocations).sort());
    expect(entries.slice(0, 2).map((e) => e.message.request_key)).toEqual([
      'first',
      'second',
    ]);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      expect(allocations[entry.message.identifier!]).toBe(
        entry.message.request_key,
      );
      expect(Number(entry.message.admitted_at_ms)).toBeGreaterThanOrEqual(
        Date.parse(sale.startsAt),
      );
      expect(Number(entry.message.admitted_at_ms)).toBeLessThan(
        Date.parse(sale.endsAt),
      );
      if (i) {
        const previous = entries[i - 1]!;
        const [ms, seq] = entry.id.split('-').map(BigInt);
        const [prevMs, prevSeq] = previous.id.split('-').map(BigInt);
        expect(ms! > prevMs! || (ms === prevMs && seq! > prevSeq!)).toBe(true);
        expect(Number(entry.message.admitted_at_ms)).toBeGreaterThanOrEqual(
          Number(previous.message.admitted_at_ms),
        );
      }
    }
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe(
      String(sale.initialStock - entries.length),
    );
    expect((await apps[0]!.inject(`/sales/${sale.id}`)).json()).toMatchObject({
      remainingStock: 0,
    });
    await expect
      .poll(
        async () => {
          const t = (await redis.sendCommand(['TIME'])) as string[];
          return (
            Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) >=
            Date.parse(sale.endsAt)
          );
        },
        { timeout: 15000, interval: 50 },
      )
      .toBe(true);
    expect(await post(1, 'FIRST', 'first')).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect(await post(0, 'late', 'late')).toEqual({
      status: 'REJECTED',
      reason: 'ended',
    });
    for (const gate of gates)
      stops.push(
        await createOrderConsumer(
          process.env.TEST_REDIS_URL!,
          database,
          gate,
          async () => [sale.id],
          (error) => errors.push(String(error)),
        ),
      );
    await expect
      .poll(
        async () => {
          const rows = await database.query(
            'SELECT user_identifier FROM "order" WHERE flash_sale_id=$1',
            [sale.id],
          );
          const pending = await redis.xPending(keys[4], orderGroup);
          return {
            identifiers: rows.rows.map((r) => r.user_identifier).sort(),
            pending: pending.pending,
            errors,
          };
        },
        { timeout: 30000, interval: 100 },
      )
      .toEqual({
        identifiers: [...acknowledged].sort(),
        pending: 0,
        errors: [],
      });
    while (stops.length) await stops.pop()!();
    const rows = await database.query(
      'SELECT id, user_identifier, admitted_at FROM "order" WHERE flash_sale_id=$1',
      [sale.id],
    );
    expect(new Set(rows.rows.map((r) => r.id)).size).toBe(entries.length);
    for (const entry of entries)
      expect(
        rows.rows
          .find((r) => r.user_identifier === entry.message.identifier)
          ?.admitted_at.getTime(),
      ).toBe(Number(entry.message.admitted_at_ms));
    // Reconcile completed work and start a fresh worker; no replenishment or extra orders.
    await gates[0]!.recover(
      sale,
      rows.rows.map((r) => ({
        identifier: r.user_identifier,
        admittedAtMs: r.admitted_at.getTime(),
        orderId: r.id,
      })),
    );
    stops.push(
      await createOrderConsumer(
        process.env.TEST_REDIS_URL!,
        database,
        gates[0]!,
        async () => [sale.id],
        (error) => errors.push(String(error)),
      ),
    );
    expect(await post(0, 'first', 'first')).toEqual({
      status: 'PROCESSING',
      phase: 'queued',
    });
    expect(
      (
        await apps[0]!.inject(`/sales/${sale.id}/order?identifier=first`)
      ).json(),
    ).toEqual({
      status: 'AVAILABLE',
      order: {
        status: 'SUCCESS',
        orderId: rows.rows.find((r) => r.user_identifier === 'first')!.id,
      },
    });
    expect((await post(1, 'FIRST', 'different')).reason).toBe('already_placed');
    expect(
      (
        await database.query('SELECT id FROM "order" WHERE flash_sale_id=$1', [
          sale.id,
        ])
      ).rowCount,
    ).toBe(acknowledged.size);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
  } finally {
    vi.restoreAllMocks();
    while (stops.length) await stops.pop()!();
    gates.forEach((gate) => gate.close());
    await Promise.all(apps.map((app) => app.close()));
    if (redis.isOpen) redis.destroy();
    await database.end();
  }
}, 60000);
