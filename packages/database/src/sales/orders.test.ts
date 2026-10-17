import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { persistOrder } from './orders.js';

const admission = { saleId: 'sale', identifier: 'person', admittedAtMs: 1234 };
function fixture({
  commitFails = false,
  timestamp = '1234',
  existing = true,
  stock = 1,
  count = 1,
} = {}) {
  let inserted = false;
  const query = vi.fn(async (sql: string) => {
    if (sql === 'COMMIT' && commitFails) throw new Error('Lost commit reply');
    if (sql.startsWith('SELECT initial_stock'))
      return { rows: [{ initial_stock: stock }] };
    if (sql.startsWith('SELECT count')) return { rows: [{ count }] };
    if (sql.startsWith('INSERT')) inserted = true;
    return {
      rows:
        sql.startsWith('SELECT id') && (existing || inserted)
          ? [{ id: 'durable-order', timestamp }]
          : [],
    };
  });
  const release = vi.fn();
  const database = {
    connect: async () => ({ query, release }),
  } as unknown as Pool;
  return { database, query, release };
}
it('commits matching replay at full capacity without inserting or checking for spare stock', async () => {
  const f = fixture();
  expect(await persistOrder(f.database, admission)).toBe('durable-order');
  const commands = f.query.mock.calls.map((call) => call[0]);
  expect(commands).toContain(
    'SELECT initial_stock FROM flash_sale WHERE id = $1 FOR UPDATE',
  );
  expect(
    commands.some(
      (sql) => sql.startsWith('INSERT') || sql.startsWith('SELECT count'),
    ),
  ).toBe(false);
  expect(commands.at(-1)).toBe('COMMIT');
  expect(f.release).toHaveBeenCalledWith(false);
});
it('rolls back conflicting identity metadata', async () => {
  const f = fixture({ timestamp: '1235' });
  await expect(persistOrder(f.database, admission)).rejects.toThrow(
    'Conflicting',
  );
  expect(f.query.mock.calls.map((call) => call[0])).not.toContain('COMMIT');
  expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(f.release).toHaveBeenCalledWith(true);
});
it('retains uncertainty on a lost commit reply and resolves redelivery through existing identity', async () => {
  const f = fixture({ commitFails: true, existing: false, count: 0 });
  await expect(persistOrder(f.database, admission)).rejects.toThrow(
    'Lost commit',
  );
  expect(f.release).toHaveBeenCalledWith(true);
  const retry = fixture();
  expect(await persistOrder(retry.database, admission)).toBe('durable-order');
  expect(retry.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(
    false,
  );
});
it.each([0, 1])(
  'refuses a new order when committed count reaches stock %s',
  async (stock) => {
    const f = fixture({ existing: false, stock, count: stock });
    await expect(persistOrder(f.database, admission)).rejects.toThrow(
      'capacity exhausted',
    );
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(
      false,
    );
    expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
  },
);
it('inserts a new order below capacity after acquiring the sale lock', async () => {
  const f = fixture({ existing: false, count: 0 });
  expect(await persistOrder(f.database, admission)).toBe('durable-order');
  const commands = f.query.mock.calls.map(([sql]) => sql);
  expect(
    commands.indexOf(
      'SELECT initial_stock FROM flash_sale WHERE id = $1 FOR UPDATE',
    ),
  ).toBeLessThan(commands.findIndex((sql) => sql.startsWith('INSERT')));
});
