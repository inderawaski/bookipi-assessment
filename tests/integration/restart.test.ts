import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { it, expect } from 'vitest';
import { testServices } from '../services.js';
it('retains PostgreSQL and AOF markers across a restart without deleting volumes', async () => {
  const { database, redis } = testServices();
  try {
    await redis.connect();
    // This table exists only inside the disposable test database, never the application schema.
    await database.query('CREATE TABLE bootstrap_marker (value text PRIMARY KEY)');
    await database.query("INSERT INTO bootstrap_marker VALUES ('persistent')");
    await redis.set('bootstrap:restart', 'persistent');
    expect(await redis.sendCommand(['WAITAOF', '1', '0', '5000'])).toEqual([1, 0]);
    redis.destroy();
    execFileSync('docker', ['compose', '-f', 'compose.test.yaml', '-p', process.env.TEST_PROJECT!, 'restart', 'postgres', 'redis'], { timeout: 30000 });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if (!redis.isReady) await redis.connect();
        await database.query('SELECT 1');
        ready = true;
        break;
      } catch { if (redis.isOpen) redis.destroy(); await setTimeout(250); }
    }
    expect(ready).toBe(true);
    expect(await redis.get('bootstrap:restart')).toBe('persistent');
    expect((await database.query('SELECT value FROM bootstrap_marker')).rows).toEqual([{ value: 'persistent' }]);
  } finally { if (redis.isOpen) redis.destroy(); await database.end(); }
}, 60000);
