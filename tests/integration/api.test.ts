import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { migrate, persistSale, persistOrder } from '../../packages/database/src/index.js';
import { DurableAdmission, admissionKeys, assertAdmissionConfiguration } from '../../packages/redis/dist/index.js';
import { createHealthServer } from '../../apps/api/src/health.js';
import { registerSaleRoutes } from '../../apps/api/src/sales/routes.js';
import { testServices } from '../services.js';

it('exposes real admission, normalization, retries, delayed state and committed orders', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), initialStock: 1 };
  const admission = new DurableAdmission(process.env.TEST_REDIS_URL!);
  const probe = async () => { await database.query('SELECT 1'); await assertAdmissionConfiguration(redis, sale); };
  const app = createHealthServer(probe);
  registerSaleRoutes(app, { database, redis, admission, probe });
  try {
    await migrate(database); await persistSale(database, sale);
    const keys = admissionKeys(sale.id);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    await admission.recover(sale, []);
    const base = `/sales/${sale.id}`;
    const submit = (identifier: string, idempotencyKey: string) => app.inject({ method: 'POST', url: `${base}/purchases`, payload: { identifier, idempotencyKey } });
    expect((await app.inject(`${base}/order?identifier=Person`)).json()).toEqual({ status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } });
    expect((await submit(' Person ', 'key')).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    // Discard the first response and retry the same logical request.
    expect((await submit('PERSON', 'key')).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect((await submit('person', 'new-key')).json()).toEqual({ status: 'REJECTED', reason: 'already_placed', existingOrder: { status: 'PROCESSING', phase: 'queued' } });
    expect((await submit('other', 'key')).json()).toEqual({ status: 'REJECTED', reason: 'idempotency_conflict' });
    expect((await submit('other', 'other-key')).json()).toEqual({ status: 'REJECTED', reason: 'sold_out' });
    expect(await redis.xLen(keys[4])).toBe(1);
    const confirmation = await admission.lookup(sale.id, 'person');
    expect(confirmation.status).toBe('durable');
    if (confirmation.status !== 'durable') throw new Error('Missing admission');
    await redis.hSet(`${keys[0]}:retries`, confirmation.reservation.streamId, JSON.stringify({ version: 1, attempts: 1, nextAt: 0, reason: 'dependency_unavailable', exhausted: false }));
    expect((await app.inject(`${base}/order?identifier=PERSON`)).json()).toEqual({ status: 'AVAILABLE', order: { status: 'PROCESSING', phase: 'delayed' } });
    const orderId = await persistOrder(database, { saleId: sale.id, identifier: 'person', admittedAtMs: confirmation.reservation.admittedAtMs });
    expect((await submit('person', 'key')).json()).toEqual({ status: 'SUCCESS', orderId });
    expect((await submit('person', 'newest-key')).json()).toEqual({ status: 'REJECTED', reason: 'already_placed', existingOrder: { status: 'SUCCESS', orderId } });
    await redis.hDel(keys[0], 'recovered_run');
    expect((await app.inject(`${base}/order?identifier=unknown`)).statusCode).toBe(503);
    expect((await app.inject(`${base}/order?identifier=person`)).json()).toEqual({ status: 'AVAILABLE', order: { status: 'SUCCESS', orderId } });
    redis.destroy();
    expect((await app.inject(`${base}/order?identifier=person`)).json()).toEqual({ status: 'AVAILABLE', order: { status: 'SUCCESS', orderId } });
    expect((await app.inject(`${base}/order?identifier=unknown`)).statusCode).toBe(503);
    await database.end();
    expect((await app.inject(`${base}/order?identifier=person`)).json()).toEqual({ status: 'UNAVAILABLE', reason: 'unavailable' });
  } finally { await app.close(); if (redis.isOpen) redis.destroy(); if (!database.ended) await database.end(); }
}, 30000);
it('replays an admitted result after closing and distinguishes upcoming and ended', async () => {
  const { database, redis } = testServices();
  await redis.connect();
  const admission = new DurableAdmission(process.env.TEST_REDIS_URL!);
  const app = createHealthServer(async () => {});
  registerSaleRoutes(app, { database, redis, admission, probe: async () => { await database.query('SELECT 1'); } });
  try {
    await migrate(database);
    const id = randomUUID();
    const start = Date.now() + 2000, end = start + 2000;
    const sale = { id, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), initialStock: 1 };
    await persistSale(database, sale);
    const keys = admissionKeys(id);
    await redis.hSet(keys[0], { starts_at: String(start), ends_at: String(end), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    await admission.recover(sale, []);
    const post = (key: string) => app.inject({ method: 'POST', url: `/sales/${id}/purchases`, payload: { identifier: 'person', idempotencyKey: key } });
    expect((await post('early')).json()).toEqual({ status: 'REJECTED', reason: 'upcoming' });
    await expect.poll(async () => {
      const time = await redis.sendCommand(['TIME']) as string[];
      return Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) >= start;
    }, { timeout: 5000, interval: 25 }).toBe(true);
    expect((await post('accepted')).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    await expect.poll(async () => {
      const time = await redis.sendCommand(['TIME']) as string[];
      return Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) >= end;
    }, { timeout: 5000, interval: 25 }).toBe(true);
    expect((await post('accepted')).json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect((await post('early')).json()).toEqual({ status: 'REJECTED', reason: 'upcoming' });
    expect((await app.inject(`/sales/${id}`)).json()).toMatchObject({ status: 'ENDED' });
    expect((await app.inject({ method: 'POST', url: `/sales/${id}/purchases`, payload: { identifier: 'other', idempotencyKey: 'late' } })).json()).toEqual({ status: 'REJECTED', reason: 'ended' });
    expect(await redis.xLen(keys[4])).toBe(1);
  } finally { await app.close(); redis.destroy(); await database.end(); }
}, 20000);
