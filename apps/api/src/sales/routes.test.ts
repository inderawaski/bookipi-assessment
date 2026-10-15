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
  const app = createHealthServer(probe);
  registerSaleRoutes(app, { database: { query }, redis: { hGet, hExists: async () => 0 }, admission: { place, lookup }, probe, webOrigin: 'http://localhost:8080' } as unknown as Parameters<typeof registerSaleRoutes>[1]);
  return { app, query, probe, place, lookup, hGet };
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
    lookup.mockResolvedValue({ status: 'confirming', diagnostic: 'durability_unavailable' });
    hGet.mockResolvedValue('bound-key');
    expect((await submit()).json()).toEqual(duplicate);
    place.mockResolvedValue({ status: 'PROCESSING', phase: 'confirming' });
    expect((await submit()).json()).toEqual({ status: 'PROCESSING', phase: 'confirming' });
  } finally { await app.close(); }
});
