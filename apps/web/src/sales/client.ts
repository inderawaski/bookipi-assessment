import type {
  LookupResponse,
  PurchaseResponse,
  SaleResponse,
} from '@flash/contracts';

export const saleId =
  new URLSearchParams(window.location.search).get('sale') || 'flash-sale';
const base = `/api/sales/${encodeURIComponent(saleId)}`;
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  // Admission rejections have useful JSON bodies even with a non-2xx status.
  const body = await response.json();
  if (!body || typeof body.status !== 'string')
    throw new Error('Invalid API response');
  return body as T;
}
export const getSale = () => request<SaleResponse>('');
export const getOrder = (identifier: string) =>
  request<LookupResponse>(`/order?${new URLSearchParams({ identifier })}`);
export const placeOrder = (identifier: string, idempotencyKey: string) =>
  request<PurchaseResponse>('/purchases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, idempotencyKey }),
  });
export const pollDelay = (attempt: number) =>
  Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
