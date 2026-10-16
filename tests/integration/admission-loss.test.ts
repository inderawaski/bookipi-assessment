import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { migrate, persistSale, persistOrder } from '../../packages/database/src/index.js';
import { RedisAdmission, admissionKeys } from '../../packages/redis/dist/index.js';
import { createHealthServer } from '../../apps/api/src/health.js';
import { registerSaleRoutes } from '../../apps/api/src/sales/routes.js';
import { processOrder, orderGroup } from '../../apps/worker/src/orders/consumer.js';
import { testServices } from '../services.js';

it('reports a lost acknowledged reservation as NOT_ORDERED and permits same-key retry without duplicate allocation', async () => {
  const { redis, database } = testServices(); await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now()-60000).toISOString(), endsAt: new Date(Date.now()+60000).toISOString(), initialStock: 1 };
  const keys = admissionKeys(sale.id), admission = new RedisAdmission(process.env.TEST_REDIS_URL!);
  const app = createHealthServer(async () => {});
  registerSaleRoutes(app, { database, redis, admission, probe: async () => {} });
  try {
    await migrate(database); await persistSale(database, sale);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    await admission.recover(sale, []);
    const post = () => app.inject({ method: 'POST', url: `/sales/${sale.id}/purchases`, payload: { identifier: 'person', idempotencyKey: 'key' } });
    expect((await post()).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    // Deterministically model restoration of an older consistent Redis snapshot.
    // SIGKILL alone normally retains OS page-cache writes and cannot force host-loss behavior.
    await redis.del(keys.slice(1)); await redis.hSet(keys[0], 'remaining_stock', '1');
    await redis.hDel(keys[0], 'recovered_run'); await admission.recover(sale, []);
    expect((await app.inject(`/sales/${sale.id}/order?identifier=person`)).json()).toEqual({ status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } });
    expect((await post()).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
  } finally { await app.close(); redis.destroy(); await database.end(); }
}, 20000);

it('caps committed orders when an in-flight commit crosses Redis reservation loss and recovery', async () => {
  const { redis, database } = testServices(); await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now()-60000).toISOString(), endsAt: new Date(Date.now()+60000).toISOString(), initialStock: 1 };
  const keys = admissionKeys(sale.id), admission = new RedisAdmission(process.env.TEST_REDIS_URL!);
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let first: Promise<string> | undefined;
  try {
    await migrate(database); await persistSale(database, sale);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    await admission.recover(sale, []);
    await admission.place(sale.id, { identifier: 'first', idempotencyKey: 'first' });
    const original = await admission.lookup(sale.id, 'first');
    if (original.status !== 'present') throw new Error('Missing first reservation');
    const identity = { saleId: sale.id, identifier: 'first', admittedAtMs: original.reservation.admittedAtMs };
    first = persistOrder(database, identity, async boundary => {
      if (boundary === 'before_commit') { entered(); await resume; }
    });
    await paused;
    // Restore an older consistent Redis snapshot while the original DB commit is in flight.
    await redis.del(keys.slice(1)); await redis.hSet(keys[0], 'remaining_stock', '1'); await redis.hDel(keys[0], 'recovered_run');
    expect((await database.query('SELECT id FROM "order" WHERE flash_sale_id=$1', [sale.id])).rows).toHaveLength(0);
    await admission.recover(sale, []);
    expect(await admission.place(sale.id, { identifier: 'second', idempotencyKey: 'second' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    await redis.xGroupCreate(keys[4], orderGroup, '0');
    const entry = (await redis.xReadGroup(orderGroup, 'replacement', { key: keys[4], id: '>' }))![0]!.messages[0]!;
    const second = processOrder(database, redis, admission, sale.id, entry);
    await delay(100); release();
    const firstId = await first; await second;
    expect((await database.query('SELECT user_identifier FROM "order" WHERE flash_sale_id=$1', [sale.id])).rows).toEqual([{ user_identifier: 'first' }]);
    // A matching replay succeeds even at capacity; a conflicting new buyer stays quarantined.
    expect(await persistOrder(database, identity)).toBe(firstId);
    expect(await redis.hExists(`${keys[0]}:quarantine`, entry.id)).toBe(1);
    expect(await redis.hGet(keys[0], 'admission_fault')).toBe('committed_order_capacity');
    expect((await redis.xPending(keys[4], orderGroup)).pending).toBe(1);
    expect((await admission.lookup(sale.id, 'second')).status).toBe('confirming');
    await expect(admission.recover(sale, [{ orderId: firstId, identifier: 'first', admittedAtMs: identity.admittedAtMs }])).rejects.toThrow('invalid accounting');
  } finally { release(); await first?.catch(() => {}); redis.destroy(); await database.end(); }
}, 20000);
