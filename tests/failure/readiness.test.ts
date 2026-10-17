import { it, expect } from 'vitest';
import { createHealthServer } from '../../apps/api/src/health.js';
import { testServices } from '../services.js';

it('reports a disconnected dependency as unavailable while remaining live', async () => {
  const { database, redis } = testServices();

  await redis.connect();

  const app = createHealthServer(async () => {
    await redis.ping();
    await database.query('SELECT 1');
  });

  try {
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    redis.destroy();
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  } finally {
    await app.close();

    if (redis.isOpen) redis.destroy();

    await database.end();
  }
});
