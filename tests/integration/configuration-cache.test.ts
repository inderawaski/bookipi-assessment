import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { migrate, persistSale, listSales } from '../../packages/database/src/index.js';
import { cachedSaleConfigurations, initializeAdmission, readAdmissionConfiguration, saleKey } from '../../packages/redis/src/index.js';
import { testServices } from '../services.js';

it('loads immutable metadata on miss, invalidates on configuration and never recreates admission stock', async () => {
  const { database, redis } = testServices();
  const scope = randomUUID();
  try {
    await migrate(database); await redis.connect();
    const load = vi.fn(() => listSales(database));
    await cachedSaleConfigurations(redis, scope, load);
    const before = load.mock.calls.length;
    const sale = { id: randomUUID(), startsAt: new Date(Date.now() + 60000).toISOString(), endsAt: new Date(Date.now() + 120000).toISOString(), initialStock: 3 };
    await persistSale(database, sale); await initializeAdmission(redis, sale);
    expect(await cachedSaleConfigurations(redis, scope, load)).toContainEqual(sale);
    expect(load).toHaveBeenCalledTimes(before + 1);
    // Cache hits remain independent from PostgreSQL configuration reads.
    load.mockRejectedValue(new Error('Database unavailable'));
    expect(await cachedSaleConfigurations(redis, scope, load)).toContainEqual(sale);
    expect(load).toHaveBeenCalledTimes(before + 1);
    // An evicted metadata cache can be filled from DB after opening, without
    // reconstructing admission state, stock or its recovery epoch.
    await redis.del(saleKey(sale.id));
    const anotherScope = randomUUID();
    expect(await cachedSaleConfigurations(redis, anotherScope, () => listSales(database))).toContainEqual(sale);
    expect(await redis.exists(saleKey(sale.id))).toBe(0);
  } finally { if (redis.isOpen) redis.destroy(); await database.end(); }
});

it('reads preloaded admission configuration without a metadata cache or database fallback', async () => {
  const { database, redis } = testServices();
  try {
    await redis.connect();
    const sale = { id: randomUUID(), startsAt: new Date(Date.now() + 60000).toISOString(), endsAt: new Date(Date.now() + 120000).toISOString(), initialStock: 3 };
    await initializeAdmission(redis, sale);
    await database.end();
    expect(await readAdmissionConfiguration(redis, sale.id)).toEqual(sale);
    expect(await readAdmissionConfiguration(redis, randomUUID())).toBeUndefined();
    await redis.hSet(saleKey(sale.id), 'starts_at', 'broken');
    await expect(readAdmissionConfiguration(redis, sale.id)).rejects.toThrow('Invalid cached sale configuration');
  } finally { if (redis.isOpen) redis.destroy(); if (!database.ended) await database.end(); }
});
