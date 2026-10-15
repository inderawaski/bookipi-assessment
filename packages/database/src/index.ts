import pg from 'pg';
export function createDatabase(connectionString: string, max: number, timeoutMs: number) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs });
  pool.on('error', () => { /* Idle connection failures are reported by the next readiness probe. */ });
  return pool;
}
export { migrate } from './sales/schema.js';
export { normalizeIdentifier, validateSale, persistSale, listSales } from './sales/configuration.js';
export type { SaleConfiguration } from './sales/configuration.js';
export { persistOrder, OrderConflictError, type OrderAdmission } from './sales/orders.js';
