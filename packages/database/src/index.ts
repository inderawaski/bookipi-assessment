import pg from 'pg';
export function createDatabase(connectionString: string, max: number, timeoutMs: number) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs });
  // A socket can emit an error while checked out, after its query has rejected.
  // Query callers handle the failure and discard uncertain connections.
  pool.on('connect', client => client.on('error', () => {}));
  pool.on('error', () => { /* Idle connection failures are reported by the next readiness probe. */ });
  return pool;
}
export { migrate } from './sales/schema.js';
export { normalizeIdentifier, validateSale, persistSale, listSales } from './sales/configuration.js';
export type { SaleConfiguration } from './sales/configuration.js';
export { persistOrder, OrderConflictError, OrderCapacityError, type OrderAdmission } from './sales/orders.js';
