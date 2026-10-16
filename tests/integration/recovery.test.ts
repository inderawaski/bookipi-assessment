import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { migrate, persistSale, persistOrder } from '../../packages/database/src/index.js';
import { RedisAdmission, admissionKeys, saleKey, claimAttempt, delayAttempt, replayOrder } from '../../packages/redis/dist/index.js';
import { createDatabase } from '../../packages/database/src/index.js';
import { createOrderConsumer } from '../../apps/worker/src/orders/consumer.js';
import { testServices } from '../services.js';
it('retains exhausted allocation, replays once, repairs missing work and completion, and fences unknown schema', async () => {
  const { redis, database } = testServices();
  await redis.connect();
  try {
    await migrate(database);
    const sale = { id: randomUUID(), startsAt: new Date(Date.now()-60000).toISOString(), endsAt: new Date(Date.now()+60000).toISOString(), initialStock: 1 };
    await persistSale(database, sale);
    const keys = admissionKeys(sale.id), prefix = saleKey(sale.id);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
    await gate.recover(sale, []);
    await gate.place(sale.id, { identifier: 'person', idempotencyKey: 'key' });
    const entry = (await redis.xRange(keys[4], '-', '+'))![0]!;
    const policy = { maxAttempts: 1, baseMs: 1, maxMs: 1 };
    expect(await claimAttempt(redis, sale.id, entry.id, policy)).toBe(1);
    expect(await claimAttempt(redis, sale.id, entry.id, policy)).toBe(0);
    await delayAttempt(redis, sale.id, entry.id, 1, policy);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    expect(JSON.parse((await redis.hGet(`${prefix}:retries`, entry.id))!).exhausted).toBe(true);
    await expect.poll(async () => {
      const state = JSON.parse((await redis.hGet(`${prefix}:retries`, entry.id))!);
      const time = await redis.sendCommand(['TIME']) as string[];
      return Number(time[0])*1000 + Math.floor(Number(time[1])/1000) >= state.nextAt;
    }).toBe(true);
    expect(await replayOrder(redis, sale.id, entry.id)).toBe(1);
    expect(await replayOrder(redis, sale.id, entry.id)).toBe(0);
    await redis.xDel(keys[4], entry.id);
    // A later validation failure leaves the earlier repair durable but admission closed.
    await expect(gate.recover(sale, [{ identifier: 'unknown', admittedAtMs: 1 }])).rejects.toThrow('invalid accounting');
    expect((await gate.lookup(sale.id, 'person')).status).toBe('confirming');
    await gate.recover(sale, []);
    const restored = await gate.lookup(sale.id, 'person');
    expect(restored.status).toBe('present');
    const admittedAtMs = Number(entry.message.admitted_at_ms);
    const orderId = await persistOrder(database, { saleId: sale.id, identifier: 'person', admittedAtMs });
    await gate.recover(sale, [{ identifier: 'person', admittedAtMs, orderId }]);
    await gate.recover(sale, [{ identifier: 'person', admittedAtMs, orderId }]);
    expect(await redis.hGet(`${prefix}:completed`, 'person')).toBe(orderId);
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    await redis.hSet(keys[0], 'configuration_version', '99');
    await expect(gate.recover(sale, [])).rejects.toThrow();
    expect((await gate.lookup(sale.id, 'person')).status).toBe('confirming');
  } finally { redis.destroy(); await database.end(); }
}, 30000);

it('exhausts during database outage and resumes once after repeated replay and worker restart', async () => {
  const { redis, database } = testServices();
  const unavailable = createDatabase('postgresql://unused:unused@127.0.0.1:1/unused', 1, 100);
  await redis.connect();
  let stop: (() => Promise<void>) | undefined;
  try {
    await migrate(database);
    const sale = { id: randomUUID(), startsAt: new Date(Date.now()-60000).toISOString(), endsAt: new Date(Date.now()+60000).toISOString(), initialStock: 1 };
    await persistSale(database, sale);
    const keys = admissionKeys(sale.id), prefix = saleKey(sale.id);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
    await gate.recover(sale, []);
    await gate.place(sale.id, { identifier: 'person', idempotencyKey: 'key' });
    const entry = (await redis.xRange(keys[4], '-', '+'))![0]!;
    const policy = { maxAttempts: 2, baseMs: 10, maxMs: 10 };
    stop = await createOrderConsumer(process.env.TEST_REDIS_URL!, unavailable, gate, async () => [sale.id], () => {}, policy);
    await expect.poll(async () => {
      const raw = await redis.hGet(`${prefix}:retries`, entry.id);
      return raw ? JSON.parse(raw).reason : undefined;
    }, { timeout: 8000 }).toBe('dependency_unavailable');
    await expect.poll(async () => JSON.parse((await redis.hGet(`${prefix}:retries`, entry.id))!).attempts, { timeout: 8000 }).toBe(2);
    await stop(); stop = undefined;
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    expect((await database.query('SELECT id FROM "order" WHERE flash_sale_id=$1', [sale.id])).rowCount).toBe(0);
    await expect.poll(async () => {
      const state = JSON.parse((await redis.hGet(`${prefix}:retries`, entry.id))!);
      const time = await redis.sendCommand(['TIME']) as string[];
      return Number(time[0])*1000 + Math.floor(Number(time[1])/1000) >= state.nextAt;
    }).toBe(true);
    expect(await replayOrder(redis, sale.id, entry.id)).toBe(1);
    expect(await replayOrder(redis, sale.id, entry.id)).toBe(0);
    stop = await createOrderConsumer(process.env.TEST_REDIS_URL!, database, gate, async () => [sale.id], () => {}, policy);
    await expect.poll(() => redis.hGet(`${prefix}:completed`, 'person'), { timeout: 8000 }).toBeTruthy();
    await stop(); stop = undefined;
    expect((await database.query('SELECT id FROM "order" WHERE flash_sale_id=$1', [sale.id])).rowCount).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    expect(await replayOrder(redis, sale.id, entry.id)).toBe(0);
  } finally { await stop?.(); redis.destroy(); await unavailable.end(); await database.end(); }
}, 30000);
