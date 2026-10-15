import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { persistOrder } from './orders.js';

const admission = { saleId: 'sale', identifier: 'person', admittedAtMs: 1234 };
function fixture(commitFails = false, timestamp = '1234') {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'COMMIT' && commitFails) throw new Error('Lost commit reply');
    return { rows: sql.includes('SELECT id') ? [{ id: 'durable-order', timestamp }] : [] };
  });
  const release = vi.fn();
  const database = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { database, query, release };
}
it('commits a matching replay and returns its existing identity', async () => {
  const f = fixture();
  expect(await persistOrder(f.database, admission)).toBe('durable-order');
  expect(f.query.mock.calls.map(call => call[0]).at(-1)).toBe('COMMIT');
  expect(f.release).toHaveBeenCalledWith(false);
});
it('rolls back conflicting identity metadata', async () => {
  const f = fixture(false, '1235');
  await expect(persistOrder(f.database, admission)).rejects.toThrow('Conflicting');
  expect(f.query.mock.calls.map(call => call[0])).not.toContain('COMMIT');
  expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(f.release).toHaveBeenCalledWith(true);
});
it('retains uncertainty on a lost commit reply and resolves redelivery through the unique insert', async () => {
  const f = fixture(true);
  await expect(persistOrder(f.database, admission)).rejects.toThrow('Lost commit');
  expect(f.release).toHaveBeenCalledWith(true);
  const retry = fixture();
  expect(await persistOrder(retry.database, admission)).toBe('durable-order');
  expect(retry.query.mock.calls[1]![0]).toContain('ON CONFLICT');
});
