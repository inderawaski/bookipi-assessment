import pg from 'pg';
export function createDatabase(connectionString: string, max: number, timeoutMs: number) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs });
  pool.on('error', () => { /* Idle connection failures are reported by the next readiness probe. */ });
  return pool;
}
