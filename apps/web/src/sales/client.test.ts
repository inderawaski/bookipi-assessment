import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { vi.stubGlobal('window', { location: { search: '?sale=sale%2Fone' } }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('sale client', () => {
  it('bounds polling backoff at thirty seconds', async () => {
    const { pollDelay } = await import('./client.js');
    expect([0, 1, 2, 3, 4, 5, 100].map(pollDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
  it('preserves structured admission rejection on an HTTP error', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 429, json: async () => ({ status: 'REJECTED', reason: 'busy' }) });
    vi.stubGlobal('fetch', fetch);
    const { placeOrder } = await import('./client.js');
    await expect(placeOrder('any + identifier', 'same-key')).resolves.toEqual({ status: 'REJECTED', reason: 'busy' });
    expect(fetch).toHaveBeenCalledWith('/api/sales/sale%2Fone/purchases', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ identifier: 'any + identifier', idempotencyKey: 'same-key' }),
    }));
  });
  it('encodes lookup identifiers as query data', async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ status: 'AVAILABLE', order: { status: 'NOT_ORDERED' } }) });
    vi.stubGlobal('fetch', fetch);
    const { getOrder } = await import('./client.js');
    await getOrder('any&identifier + ?');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sales/sale%2Fone/order?identifier=any%26identifier+%2B+%3F');
  });
  it('treats proxy errors as uncertain delivery rather than a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => { throw new SyntaxError('Not JSON'); } }));
    const { placeOrder } = await import('./client.js');
    await expect(placeOrder('person', 'key')).rejects.toThrow('Not JSON');
  });
});
