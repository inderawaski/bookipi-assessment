import { it, expect } from 'vitest';
import { createHealthServer } from './health.js';
it('stays live while an unavailable dependency prevents readiness, then recovers', async () => {
  let available = false;
  const app = createHealthServer(async () => {
    if (!available) throw new Error('offline');
  });
  try {
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    available = true;
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
