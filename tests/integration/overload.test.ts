import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { migrate, persistSale } from '../../packages/database/src/index.js';
import { RedisAdmission, admissionKeys, assertAdmissionConfiguration } from '../../packages/redis/dist/index.js';
import { createHealthServer } from '../../apps/api/src/health.js';
import { registerSaleRoutes } from '../../apps/api/src/sales/routes.js';
import { testServices } from '../services.js';

it('shares last stock and duplicate mappings across independently bounded API instances', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), initialStock: 1 };
  const apps = [createHealthServer(async () => {}), createHealthServer(async () => {})];
  const admissions = apps.map(() => new RedisAdmission(process.env.TEST_REDIS_URL!, 2));
  try {
    await migrate(database); await persistSale(database, sale);
    const keys = admissionKeys(sale.id);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    await admissions[0]!.recover(sale, []);
    apps.forEach((app, i) => registerSaleRoutes(app, { configurationScope: '/flash_test', database, redis, admission: admissions[i]!, probe: async () => {} }));
    const submit = (i: number, identifier: string, idempotencyKey: string) => apps[i]!.inject({ method: 'POST', url: `/sales/${sale.id}/purchases`, payload: { identifier, idempotencyKey } });
    const results = await Promise.all([submit(0, 'first', 'first'), submit(1, 'second', 'second')]);
    expect(results.map(r => r.json().status).sort()).toEqual(['PROCESSING', 'REJECTED']);
    const winner = results[0]!.json().status === 'PROCESSING' ? 'first' : 'second';
    expect((await submit(1, winner, winner)).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect((await submit(0, winner, 'new')).json()).toMatchObject({ status: 'REJECTED', reason: 'already_placed' });
    expect(await redis.xLen(keys[4])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    await assertAdmissionConfiguration(redis, sale);
    expect(await redis.configGet(['appendfsync'])).toEqual({ appendfsync: 'everysec' });
  } finally { await Promise.all(apps.map(app => app.close())); redis.destroy(); await database.end(); }
}, 30000);

it('rejects an exhausted admission pool before send and recovers without losing admitted work', async () => {
  const { redis, database } = testServices();
  await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), initialStock: 2 };
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!, 1);
  const keys = admissionKeys(sale.id);
  try {
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '2', remaining_stock: '2', configuration_version: '1' });
    await gate.recover(sale, []);
    const first = gate.place(sale.id, { identifier: 'first', idempotencyKey: 'first' });
    expect(await gate.place(sale.id, { identifier: 'second', idempotencyKey: 'second' })).toEqual({ status: 'REJECTED', reason: 'busy' });
    expect(await first).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(1); // worker outage retains a bounded-by-stock backlog
    expect(await gate.place(sale.id, { identifier: 'second', idempotencyKey: 'second' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(2);
    expect(await redis.configGet(['appendfsync'])).toEqual({ appendfsync: 'everysec' });
  } finally { redis.destroy(); await database.end(); }
}, 15000);

it('admits without waiting for an exhausted database pool', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
  const app = createHealthServer(async () => {});
  registerSaleRoutes(app, { configurationScope: '/flash_test', database, redis, admission: gate, probe: async () => {} });
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), initialStock: 1 };
  const keys = admissionKeys(sale.id);
  await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
  await gate.recover(sale, []);
  const clients = await Promise.all([database.connect(), database.connect()]);
  try {
    const id = sale.id;
    const result = await app.inject({ method: 'POST', url: `/sales/${id}/purchases`, payload: { identifier: 'person', idempotencyKey: 'key' } });
    expect(result.json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(database.waitingCount).toBe(0);
    expect(await redis.xLen(keys[4])).toBe(1);
  } finally { clients.forEach(client => client.release()); await app.close(); redis.destroy(); await database.end(); }
}, 10000);
