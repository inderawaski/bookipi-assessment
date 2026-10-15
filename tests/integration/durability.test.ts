import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DurableAdmission, admissionKeys, admitPurchase } from '../../packages/redis/src/index.js';
import { confirmationScript } from '../../packages/redis/src/sales/durability-scripts.js';
import { testServices } from '../services.js';

async function fixture() {
  const { redis, database } = testServices();
  await database.end();
  await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), initialStock: 2 };
  const keys = admissionKeys(sale.id);
  await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '2', remaining_stock: '2', configuration_version: '1' });
  const gate = new DurableAdmission(process.env.TEST_REDIS_URL!);
  return { redis, sale, keys, gate };
}
it('fences unreconciled sales, confirms replay/duplicates/lookup, and gates worker evidence', async () => {
  const f = await fixture();
  try {
    expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
    await f.gate.recover(f.sale, []);
    expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await f.gate.place(f.sale.id, { identifier: 'PERSON', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'new' })).toEqual({ status: 'REJECTED', reason: 'already_placed', existingOrder: { status: 'PROCESSING', phase: 'queued' } });
    const lookup = await f.gate.lookup(f.sale.id, ' Person ');
    expect(lookup.status).toBe('durable');
    if (lookup.status !== 'durable') throw new Error('Unconfirmed');
    await expect(f.gate.confirmForWorker(f.sale.id, 'person', 'key', lookup.reservation.streamId)).resolves.toMatchObject({ requestKey: 'key' });
    await expect(f.gate.confirmForWorker(f.sale.id, 'person', 'other', lookup.reservation.streamId)).rejects.toThrow('unconfirmed');
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
  } finally { f.redis.destroy(); }
});
it('never treats missing lookup as rejection, including a delayed admission executing afterward', async () => {
  const f = await fixture();
  try {
    await f.gate.recover(f.sale, []);
    expect(await f.gate.lookup(f.sale.id, 'person')).toEqual({ status: 'confirming', diagnostic: 'missing_without_absence_proof' });
    await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'delayed' });
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('durable');
  } finally { f.redis.destroy(); }
});
it('confirms a different connection reservation by advancing its own AOF prefix', async () => {
  const f = await fixture();
  try {
    expect((await f.redis.info('server')).includes('redis_version:7.4.8')).toBe(true);
    await f.gate.recover(f.sale, []);
    // Raw Lua intentionally has no barrier; the fresh lookup connection must write before waiting.
    await admitPurchase(f.redis, f.sale.id, { identifier: 'person', idempotencyKey: 'raw' });
    const before = Number(await f.redis.hGet(f.keys[0], 'confirmation_checkpoint'));
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('durable');
    expect(Number(await f.redis.hGet(f.keys[0], 'confirmation_checkpoint'))).toBe(before + 1);
    // Exercise the actual write/checkpoint + WAITAOF pair on the owning connection.
    await f.redis.sendCommand(['EVAL', confirmationScript, '5', ...f.keys, 'person', f.sale.id]);
    expect(await f.redis.sendCommand(['WAITAOF', '1', '0', '2000'])).toEqual([1, 0]);
  } finally { f.redis.destroy(); }
});
it('recovery preserves pending stock and refuses mismatched DB orders or queue data', async () => {
  const f = await fixture();
  try {
    await f.gate.recover(f.sale, []);
    await admitPurchase(f.redis, f.sale.id, { identifier: 'person', idempotencyKey: 'pending' });
    await f.gate.recover(f.sale, []);
    expect(await f.redis.hGet(f.keys[0], 'remaining_stock')).toBe('1');
    await expect(f.gate.recover(f.sale, [{ identifier: 'absent', admittedAtMs: 1 }])).rejects.toThrow('invalid accounting');
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('confirming');
    await f.gate.recover(f.sale, []);
    await f.redis.del(f.keys[4]);
    await expect(f.gate.recover(f.sale, [])).rejects.toThrow('invalid accounting');
  } finally { f.redis.destroy(); }
});
it('validates matching DB orders and refuses expiring allocation state', async () => {
  const f = await fixture();
  try {
    await f.gate.recover(f.sale, []);
    const result = await admitPurchase(f.redis, f.sale.id, { identifier: 'person', idempotencyKey: 'key' });
    if (result.status !== 'reserved') throw new Error('Missing reservation');
    await f.gate.recover(f.sale, [{ identifier: 'person', admittedAtMs: result.reservation.admittedAtMs }]);
    await f.redis.pExpire(f.keys[3], 60000);
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('confirming');
    await expect(f.gate.recover(f.sale, [])).rejects.toThrow('invalid accounting');
  } finally { f.redis.destroy(); }
});
