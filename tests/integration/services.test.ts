import { it, expect } from 'vitest';
import { testServices } from '../services.js';
import { assertRedisSafety, createRedisConnection } from '../../packages/redis/src/index.js';
it('connects to isolated PostgreSQL and Redis with the required persistence policy', async () => {
  const { database, redis } = testServices();
  try {
    await redis.connect();
    await assertRedisSafety(redis);
    expect((await database.query('SELECT current_database() AS name')).rows[0].name).toBe('flash_test');
    const blocker = createRedisConnection(process.env.TEST_REDIS_URL!, 'blocking-consumer');
    try {
      await blocker.connect();
      let completed = false;
      const blocked = blocker.sendCommand(['XREAD', 'BLOCK', '300', 'STREAMS', 'bootstrap:empty', '$']).finally(() => { completed = true; });
      expect(await redis.ping()).toBe('PONG');
      expect(completed).toBe(false);
      await blocked;
    } finally { if (blocker.isOpen) blocker.destroy(); }
  } finally { if (redis.isOpen) redis.destroy(); await database.end(); }
});
it('keeps durability waits off unrelated command traffic', async () => {
  const { database, redis } = testServices();
  const durability = createRedisConnection(process.env.TEST_REDIS_URL!, 'durability');
  try {
    await redis.connect(); await durability.connect();
    await durability.set('bootstrap:durability', 'written');
    let completed = false;
    // No replica exists: this wait must last until its finite timeout.
    const waiting = durability.sendCommand(['WAITAOF', '1', '1', '300']).finally(() => { completed = true; });
    expect(await redis.ping()).toBe('PONG');
    expect(completed).toBe(false);
    expect(await waiting).toEqual([1, 0]);
  } finally { if (durability.isOpen) durability.destroy(); if (redis.isOpen) redis.destroy(); await database.end(); }
});
