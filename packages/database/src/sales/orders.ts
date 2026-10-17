import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface OrderAdmission {
  saleId: string;
  identifier: string;
  admittedAtMs: number;
}
export class OrderConflictError extends Error {}
export class OrderCapacityError extends OrderConflictError {}
/** A sale-row lock caps committed orders; matching redelivery remains valid at capacity. */
export async function persistOrder(
  database: Pool,
  admission: OrderAdmission,
  failpoint?: (boundary: string) => Promise<void>,
): Promise<string> {
  if (failpoint && process.env.NODE_ENV !== 'test')
    throw new Error('Failpoints require test mode');
  const client = await database.connect();
  let failed = false;
  try {
    await failpoint?.('before_transaction');
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await failpoint?.('after_begin');
    // Redis may restore an older snapshot while another worker is committing.
    // All final writers lock this row, then read a fresh READ COMMITTED snapshot.
    const sale = (
      await client.query<{ initial_stock: number }>(
        'SELECT initial_stock FROM flash_sale WHERE id = $1 FOR UPDATE',
        [admission.saleId],
      )
    ).rows[0];
    if (!sale) throw new OrderConflictError('Missing sale configuration');
    const lookup = `SELECT id, (extract(epoch FROM admitted_at) * 1000)::bigint::text AS timestamp FROM "order"
      WHERE flash_sale_id = $1 AND user_identifier = $2`;
    const identity = [admission.saleId, admission.identifier];
    let order = (
      await client.query<{ id: string; timestamp: string }>(lookup, identity)
    ).rows[0];
    if (!order) {
      const count = (
        await client.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM "order" WHERE flash_sale_id = $1',
          [admission.saleId],
        )
      ).rows[0]!.count;
      if (count >= sale.initial_stock)
        throw new OrderCapacityError(
          'Committed order capacity exhausted; admission reconciliation required',
        );
      await client.query(
        `INSERT INTO "order" (id, flash_sale_id, user_identifier, admitted_at, completed_at)
        VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), greatest(clock_timestamp(), to_timestamp($4::double precision / 1000)))
        ON CONFLICT (flash_sale_id, user_identifier) DO NOTHING`,
        [
          randomUUID(),
          admission.saleId,
          admission.identifier,
          admission.admittedAtMs,
        ],
      );
      order = (
        await client.query<{ id: string; timestamp: string }>(lookup, identity)
      ).rows[0];
    }
    if (!order || Number(order.timestamp) !== admission.admittedAtMs)
      throw new OrderConflictError('Conflicting durable order metadata');
    await failpoint?.('before_commit');
    await client.query('COMMIT');
    await failpoint?.('after_commit');
    return order.id;
  } catch (error) {
    failed = true;
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Discard the uncertain connection below. */
    }
    throw error;
  } finally {
    client.release(failed);
  }
}
