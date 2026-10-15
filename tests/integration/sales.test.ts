import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { migrate, persistSale, normalizeIdentifier } from '../../packages/database/src/index.js';
import { initializeAdmission, assertAdmissionConfiguration, saleKey } from '../../packages/redis/src/index.js';
import { testServices } from '../services.js';

it('migrates and enforces order uniqueness, FK, ranges and immutable sale configuration', async () => {
  const { database, redis } = testServices();
  try {
    await migrate(database); await migrate(database);
    const sale = await persistSale(database, { id: randomUUID(), startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-02T00:00:00Z', initialStock: 3 });
    const insert = (id: string, saleId: string, user: string) => database.query('INSERT INTO "order" (id, flash_sale_id, user_identifier, admitted_at, completed_at) VALUES ($1,$2,$3,$4,$5)', [id, saleId, normalizeIdentifier(user), sale.startsAt, sale.endsAt]);
    await insert(randomUUID(), sale.id, " Person '+ 人 ");
    await expect(insert(randomUUID(), sale.id, "PERSON '+ 人")).rejects.toMatchObject({ code: '23505' });
    await expect(insert(randomUUID(), randomUUID(), 'other')).rejects.toMatchObject({ code: '23503' });
    await expect(database.query('UPDATE flash_sale SET initial_stock = 4 WHERE id = $1', [sale.id])).rejects.toThrow('immutable');
    await expect(database.query('INSERT INTO flash_sale (id, starts_at, ends_at, initial_stock) VALUES ($1, now(), now(), 0)', [randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(database.query("INSERT INTO flash_sale (id, starts_at, ends_at, initial_stock) VALUES ($1, now(), now() + interval '1 day', -1)", [randomUUID()])).rejects.toMatchObject({ code: '23514' });
  } finally { if (redis.isOpen) redis.destroy(); await database.end(); }
});

it('keeps partial initialization unavailable, resumes safely, and never reseeds reservations', async () => {
  const { database, redis } = testServices();
  try {
    await migrate(database); await redis.connect();
    const sale = await persistSale(database, { id: randomUUID(), startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-02T00:00:00Z', initialStock: 3 });
    // Exact crash boundary: DB committed, Redis initialization has not run.
    await expect(assertAdmissionConfiguration(redis, sale)).rejects.toThrow('missing');
    await initializeAdmission(redis, sale);
    await redis.hSet(saleKey(sale.id), 'remaining_stock', '1');
    await initializeAdmission(redis, await persistSale(database, sale));
    expect(await redis.hGet(saleKey(sale.id), 'remaining_stock')).toBe('1');
    await assertAdmissionConfiguration(redis, sale);
    await expect(persistSale(database, { ...sale, initialStock: 9 })).rejects.toThrow('Conflicting');
    await expect(initializeAdmission(redis, { ...sale, initialStock: 9 })).rejects.toThrow('Conflicting');
    const zero = await persistSale(database, { ...sale, id: randomUUID(), initialStock: 0 });
    await initializeAdmission(redis, zero);
    expect(await redis.hGet(saleKey(zero.id), 'remaining_stock')).toBe('0');
    const ended = await persistSale(database, { ...sale, id: randomUUID(), startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-02T00:00:00Z' });
    await expect(initializeAdmission(redis, ended)).rejects.toThrow('repair');
    // Existing state remains usable after closing, without reseeding.
    await redis.hSet(saleKey(ended.id), { starts_at: String(Date.parse(ended.startsAt)), ends_at: String(Date.parse(ended.endsAt)), initial_stock: '3', remaining_stock: '0' });
    await initializeAdmission(redis, ended);
    await assertAdmissionConfiguration(redis, ended);
    expect(await redis.hGet(saleKey(ended.id), 'remaining_stock')).toBe('0');
  } finally { if (redis.isOpen) redis.destroy(); await database.end(); }
});
