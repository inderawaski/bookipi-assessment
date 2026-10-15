import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface OrderAdmission { saleId: string; identifier: string; admittedAtMs: number }
export class OrderConflictError extends Error {}
/** Unique constraints serialize concurrent deliveries. A lost COMMIT reply is retried by lookup. */
export async function persistOrder(database: Pool, admission: OrderAdmission): Promise<string> {
  const client = await database.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO "order" (id, flash_sale_id, user_identifier, admitted_at, completed_at)
      VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), greatest(clock_timestamp(), to_timestamp($4::double precision / 1000)))
      ON CONFLICT (flash_sale_id, user_identifier) DO NOTHING`,
    [randomUUID(), admission.saleId, admission.identifier, admission.admittedAtMs]);
    const result = await client.query<{ id: string; timestamp: string }>(
      `SELECT id, (extract(epoch FROM admitted_at) * 1000)::bigint::text AS timestamp FROM "order"
       WHERE flash_sale_id = $1 AND user_identifier = $2`, [admission.saleId, admission.identifier]);
    const order = result.rows[0];
    if (!order || Number(order.timestamp) !== admission.admittedAtMs) throw new OrderConflictError('Conflicting durable order metadata');
    await client.query('COMMIT');
    return order.id;
  } catch (error) {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { /* Discard the uncertain connection below. */ }
    throw error;
  } finally { client.release(failed); }
}
