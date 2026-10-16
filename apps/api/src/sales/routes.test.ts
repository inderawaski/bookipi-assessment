import { Metrics } from '@flash/operations';
import type { PurchaseResponse } from '@flash/contracts';
import type { Confirmation } from '@flash/redis';
import { it, expect, vi } from 'vitest';
import { createHealthServer } from '../health.js';
import { registerSaleRoutes } from './routes.js';

function fixture() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: sql.includes('flash_sale ORDER') ? [{ id: 'sale', starts_at: new Date(0), ends_at: new Date('2099-01-01'), initial_stock: 2 }] : [] }));
  const probe = vi.fn(async () => {});
  const place = vi.fn(async (): Promise<PurchaseResponse> => ({ status: 'PROCESSING', phase: 'queued' }));
  const lookup = vi.fn(async (): Promise<Confirmation> => ({ status: 'confirming', diagnostic: 'missing_without_absence_proof' }));
  const hGet = vi.fn(async () => '2');
  let cached = '';
  const sendCommand = vi.fn(async (args: string[]) => {
    if (args[0] === 'HMGET') return [null, null, null, null];
    if (args[2] === '2' && args.length === 5) return ['0', cached];
    cached = args[6]!; return 1;
  });
  const app = createHealthServer(probe);
  const metrics = new Metrics();
  registerSaleRoutes(app, { configurationScope: '/flash_test', database: { query }, redis: { sendCommand, hGet, hExists: async () => 0 }, admission: { place, lookup }, probe, metrics, webOrigin: 'http://localhost:8080' } as unknown as Parameters<typeof registerSaleRoutes>[1]);
  return { app, query, probe, place, lookup, hGet, metrics, sendCommand };
}
it('serves status, encoded generic identities, strict validation, CORS and size bounds', async () => {
  const { app, place } = fixture();
  try {
    const status = await app.inject('/sales/SALE');
    expect(status.json()).toMatchObject({ saleId: 'sale', status: 'OPEN', remainingStock: 2 });
    expect(Number.isFinite(Date.parse(status.json().observedAt))).toBe(true);
    const post = (payload: object) => app.inject({ method: 'POST', url: '/sales/sale/purchases', payload });
    expect((await post({ identifier: ' @. /? ', idempotencyKey: 'key' })).statusCode).toBe(202);
    expect(place).toHaveBeenCalledWith('sale', { saleId: 'sale', identifier: '@. /?', idempotencyKey: 'key' });
    for (const payload of [{ identifier: 1, idempotencyKey: 'key' }, { identifier: ' ', idempotencyKey: 'key' }, { identifier: 'a', idempotencyKey: 'key', quantity: 1 }, { identifier: 'a', idempotencyKey: 'bad key' }]) expect((await post(payload)).statusCode).toBe(400);
    expect((await app.inject('/sales/missing')).statusCode).toBe(404);
    expect((await app.inject('/sales/sale/order?identifier=%00')).statusCode).toBe(400);
    expect((await app.inject('/sales/sale/order?identifier=a')).json()).toEqual({ status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } });
    expect((await app.inject({ url: '/sales/sale', headers: { origin: 'http://localhost:8080' } })).headers['access-control-allow-origin']).toBe('http://localhost:8080');
    expect((await app.inject({ method: 'OPTIONS', url: '/sales/sale/purchases', headers: { origin: 'http://localhost:8080' } })).statusCode).toBe(204);
    expect((await app.inject('/sales/sale/order?identifier=' + 'a'.repeat(8200))).statusCode).toBe(414);
    expect((await post({ identifier: 'a'.repeat(17000), idempotencyKey: 'key' })).statusCode).toBe(413);
  } finally { await app.close(); }
});
it('never invents absence on database/readiness outages and reads success without Redis', async () => {
  const { app, query, probe } = fixture();
  try {
    probe.mockRejectedValue(new Error('offline'));
    expect((await app.inject('/sales/sale/order?identifier=a')).statusCode).toBe(503);
    query.mockImplementation(async sql => ({ rows: sql.includes('flash_sale ORDER') ? [{ id: 'sale', starts_at: new Date(0), ends_at: new Date('2099-01-01'), initial_stock: 2 }] : [{ id: 'order-1' }] }));
    expect((await app.inject('/sales/sale/order?identifier=a')).json()).toEqual({ status: 'AVAILABLE', order: { status: 'SUCCESS', orderId: 'order-1' } });
    query.mockRejectedValue(new Error('offline'));
    expect((await app.inject('/sales/sale/order?identifier=a')).json()).toEqual({ status: 'UNAVAILABLE', reason: 'unavailable' });
  } finally { await app.close(); }
});
it('preserves every admission rejection, uncertain result and duplicate state', async () => {
  const { app, place, lookup, hGet } = fixture();
  try {
    const submit = () => app.inject({ method: 'POST', url: '/sales/sale/purchases', payload: { identifier: 'person', idempotencyKey: 'key' } });
    for (const reason of ['upcoming', 'ended', 'sold_out', 'idempotency_conflict', 'busy', 'unavailable'] as const) {
      place.mockResolvedValue({ status: 'REJECTED', reason });
      const response = await submit();
      expect(response.statusCode).toBe(reason === 'busy' ? 429 : reason === 'unavailable' ? 503 : 409);
      expect(response.json()).toEqual({ status: 'REJECTED', reason });
    }
    const duplicate = { status: 'REJECTED', reason: 'already_placed', existingOrder: { status: 'PROCESSING', phase: 'confirming' } } as const;
    place.mockResolvedValue(duplicate);
    lookup.mockResolvedValue({ status: 'confirming', diagnostic: 'admission_unavailable' });
    hGet.mockResolvedValue('bound-key');
    expect((await submit()).json()).toEqual({ ...duplicate, existingOrder: { status: 'NOT_ORDERED', reason: 'confirmation_uncertain' } });
    place.mockResolvedValue({ status: 'PROCESSING', phase: 'confirming' });
    expect((await submit()).json()).toEqual({ status: 'NOT_ORDERED', reason: 'confirmation_uncertain' });
  } finally { await app.close(); }
});

it('accounts fixed purchase outcomes without identifier labels', async () => {
  const { app, place, metrics } = fixture();
  try {
    const outcomes: PurchaseResponse[] = [{ status: 'PROCESSING', phase: 'queued' }, { status: 'PROCESSING', phase: 'confirming' }, { status: 'REJECTED', reason: 'sold_out' }, { status: 'REJECTED', reason: 'invalid_input' }];
    for (const outcome of outcomes) {
      place.mockResolvedValue(outcome);
      await app.inject({ method: 'POST', url: '/sales/sale/purchases', payload: { identifier: 'private-identifier', idempotencyKey: 'key' } });
    }
    const result = metrics.render();
    for (const name of ['admitted', 'uncertain', 'sold_out', 'invalid_input']) expect(result).toContain(`flash_purchase_${name}_total 1\n`);
    expect(result).not.toContain('private-identifier');
  } finally { await app.close(); }
});

it('empty lookup is an observation and an unconfirmed submission can resolve on replay', async () => {
  const { app, place, query } = fixture();
  const payload = { identifier: 'person', idempotencyKey: 'same-key' };
  try {
    place.mockResolvedValue({ status: 'PROCESSING', phase: 'confirming' });
    const first = await app.inject({ method: 'POST', url: '/sales/sale/purchases', payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ status: 'NOT_ORDERED', reason: 'confirmation_uncertain' });
    expect((await app.inject('/sales/sale/order?identifier=person')).json()).toEqual({ status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } });
    query.mockImplementation(async sql => ({ rows: sql.includes('flash_sale ORDER') ? [{ id: 'sale', starts_at: new Date(0), ends_at: new Date('2099-01-01'), initial_stock: 2 }] : [{ id: 'committed-later' }] }));
    place.mockResolvedValue({ status: 'PROCESSING', phase: 'queued' });
    const replay = await app.inject({ method: 'POST', url: '/sales/sale/purchases', payload });
    expect(replay.json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect((await app.inject('/sales/sale/order?identifier=person')).json()).toEqual({ status: 'AVAILABLE', order: { status: 'SUCCESS', orderId: 'committed-later' } });
    expect(place.mock.calls).toEqual([['sale', { saleId: 'sale', ...payload }], ['sale', { saleId: 'sale', ...payload }]]);
  } finally { await app.close(); }
});

it('admits using only Redis even when PostgreSQL and the readiness probe are unavailable', async () => {
  const { app, place, query, probe } = fixture();
  try {
    query.mockRejectedValue(new Error('PostgreSQL unavailable'));
    probe.mockRejectedValue(new Error('Readiness unavailable'));
    place.mockResolvedValue({ status: 'PROCESSING', phase: 'queued' });
    const response = await app.inject({ method: 'POST', url: '/sales/sale/purchases', payload: { identifier: 'person', idempotencyKey: 'key' } });
    expect(response.json()).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(place).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('serves cached sale configuration without another database read', async () => {
  const { app, query } = fixture();
  try {
    expect((await app.inject('/sales/sale')).statusCode).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    query.mockRejectedValue(new Error('Unexpected configuration database read'));
    expect((await app.inject('/sales/sale')).json()).toMatchObject({ saleId: 'sale', remainingStock: 2 });
    expect(query).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('uses sale fields already preloaded for Lua without filling a second cache from PostgreSQL', async () => {
  const { app, query, sendCommand } = fixture();
  try {
    sendCommand.mockImplementation(async args => {
      if (args[0] === 'HMGET') return ['0', String(Date.parse('2099-01-01')), '2', '1'];
      throw new Error('Unexpected cache fallback');
    });
    query.mockRejectedValue(new Error('Unexpected database read'));
    expect((await app.inject('/sales/sale')).json()).toMatchObject({ saleId: 'sale', remainingStock: 2 });
    expect(query).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
