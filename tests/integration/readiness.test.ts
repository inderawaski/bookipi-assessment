import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import {
  createDatabase,
  migrate,
  persistSale,
} from '../../packages/database/dist/index.js';
import {
  RedisAdmission,
  initializeAdmission,
  saleKey,
} from '../../packages/redis/dist/index.js';
import { startService as startApi } from '../../apps/api/src/service.js';
import { startService as startWorker } from '../../apps/worker/src/service.js';
import { testServices } from '../services.js';

async function freePort() {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string')
    throw new Error('Missing test port');

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return String(address.port);
}

it('shares overlapping probes per instance and reconciles across two APIs and a worker without false unready responses', async () => {
  const { database: admin, redis } = testServices();
  // Isolate the actual service's sale scan from other integration fixtures.
  const name = `flash_test_readiness_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.TEST_DATABASE_URL!);

  url.pathname = `/${name}`;

  const database = createDatabase(url.href, 2, 2000);
  const keys = [
    'DATABASE_URL',
    'REDIS_URL',
    'API_PORT',
    'WORKER_PORT',
    'HOST',
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const apps: Awaited<ReturnType<typeof startApi>>[] = [];
  let created = false;

  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(database);
    await redis.connect();
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      REDIS_URL: process.env.TEST_REDIS_URL,
      HOST: '127.0.0.1',
    });

    for (let i = 0; i < 2; i++) {
      process.env.API_PORT = await freePort();
      apps.push(await startApi('api'));
    }

    process.env.WORKER_PORT = await freePort();
    apps.push(await startWorker('worker'));

    const recover = vi.spyOn(RedisAdmission.prototype, 'recover');
    const sale = {
      id: randomUUID(),
      startsAt: new Date(Date.now() + 60000).toISOString(),
      endsAt: new Date(Date.now() + 120000).toISOString(),
      initialStock: 10000,
    };

    await persistSale(database, sale);
    await initializeAdmission(redis, sale);

    const responses = await Promise.all(
      apps.flatMap((app) =>
        Array.from({ length: 8 }, () => app.inject('/health/ready')),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual(
      Array(24).fill(200),
    );
    expect(recover).toHaveBeenCalledTimes(3);
    expect(
      (await Promise.all(apps.map((app) => app.inject('/health/ready')))).map(
        (response) => response.statusCode,
      ),
    ).toEqual([200, 200, 200]);
    expect(recover).toHaveBeenCalledTimes(3);
    // Sharing work is not caching success: a real fault must close readiness.
    await redis.hSet(saleKey(sale.id), 'admission_fault', 'test corruption');
    expect(
      (await Promise.all(apps.map((app) => app.inject('/health/ready')))).map(
        (response) => response.statusCode,
      ),
    ).toEqual([503, 503, 503]);
    await redis.hDel(saleKey(sale.id), 'admission_fault');
    expect(
      (await Promise.all(apps.map((app) => app.inject('/health/ready')))).map(
        (response) => response.statusCode,
      ),
    ).toEqual([200, 200, 200]);
    expect(await redis.hGet(saleKey(sale.id), 'remaining_stock')).toBe('10000');
    expect(await redis.hGet(saleKey(sale.id), 'admission_fault')).toBeNull();
    expect(
      (await database.query('SELECT count(*)::int AS count FROM "order"'))
        .rows[0].count,
    ).toBe(0);
  } finally {
    vi.restoreAllMocks();

    for (const app of apps.reverse()) await app.close();

    if (redis.isOpen) redis.destroy();

    await database.end();

    if (created) await admin.query(`DROP DATABASE "${name}"`);

    await admin.end();

    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}, 30000);
