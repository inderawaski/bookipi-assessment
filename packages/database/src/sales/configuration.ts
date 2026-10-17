import type { Pool } from 'pg';

export interface SaleConfiguration {
  id: string;
  startsAt: string;
  endsAt: string;
  initialStock: number;
}
import { normalizeIdentifier } from '@flash/contracts';
export { normalizeIdentifier } from '@flash/contracts';
function instant(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(
      'Expected an ISO timestamp with explicit timezone and millisecond precision or less',
    );
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    Number(value.slice(11, 13)) > 23
  ) {
    throw new Error('Invalid calendar instant');
  }
  return new Date(value).toISOString();
}
export function validateSale(input: SaleConfiguration): SaleConfiguration {
  const sale = {
    ...input,
    id: normalizeIdentifier(input.id),
    startsAt: instant(input.startsAt),
    endsAt: instant(input.endsAt),
  };
  if (sale.endsAt <= sale.startsAt)
    throw new Error('Sale end must follow start');
  if (
    !Number.isInteger(sale.initialStock) ||
    sale.initialStock < 0 ||
    sale.initialStock > 2147483647
  )
    throw new Error('Stock must be an integer from 0 to 2147483647');
  return sale;
}
export async function listSales(database: Pool): Promise<SaleConfiguration[]> {
  const result = await database.query(
    'SELECT id, starts_at, ends_at, initial_stock FROM flash_sale ORDER BY id',
  );
  return result.rows.map((row) => ({
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    initialStock: row.initial_stock,
  }));
}
export async function persistSale(
  database: Pool,
  input: SaleConfiguration,
): Promise<SaleConfiguration> {
  const sale = validateSale(input);
  await database.query(
    'INSERT INTO flash_sale (id, starts_at, ends_at, initial_stock) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [sale.id, sale.startsAt, sale.endsAt, sale.initialStock],
  );
  const result = await database.query(
    'SELECT starts_at, ends_at, initial_stock FROM flash_sale WHERE id = $1',
    [sale.id],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.starts_at.toISOString() !== sale.startsAt ||
    row.ends_at.toISOString() !== sale.endsAt ||
    row.initial_stock !== sale.initialStock
  )
    throw new Error('Conflicting sale configuration');
  return sale;
}
