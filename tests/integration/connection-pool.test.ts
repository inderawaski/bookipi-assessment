import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RedisAdmission, admissionKeys } from '../../packages/redis/src/index.js';
import { testServices } from '../services.js';

it('warms the library default minimum and reuses its socket until shutdown', async () => {
  const { redis, database } = testServices();
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
  try {
    await database.end(); await redis.connect();
    const clients = async () => new Set((await redis.sendCommand(['CLIENT', 'LIST']) as string).split('\n')
      .filter(line => line.includes('name=admission ')).map(line => /^id=(\d+)/.exec(line)![1]));
    const before = await clients();
    await gate.connect();
    const warm = await clients();
    const owned = [...warm].filter(id => !before.has(id));
    expect(owned).toHaveLength(1);
    const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), initialStock: 1 };
    const keys = admissionKeys(sale.id);
    await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '1', remaining_stock: '1', configuration_version: '1' });
    await gate.recover(sale, []);
    for (let i = 0; i < 20; i++) expect(await gate.place(sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await clients()).toEqual(warm);
    expect(await redis.xLen(keys[4])).toBe(1);
    gate.close();
    await expect.poll(clients).toEqual(before);
  } finally { gate.close(); if (redis.isOpen) redis.destroy(); if (!database.ended) await database.end(); }
});
