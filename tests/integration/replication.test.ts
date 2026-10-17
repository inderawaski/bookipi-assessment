import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createRedisConnection,
  RedisAdmission,
  admissionKeys,
} from '../../packages/redis/src/index.js';
import { testServices } from '../services.js';

it('maintains one asynchronous read-only replica and copies primary admissions', async () => {
  const { redis, database } = testServices();
  const replica = createRedisConnection(
    process.env.TEST_REDIS_REPLICA_URL!,
    'commands',
  );

  await database.end();
  await Promise.all([redis.connect(), replica.connect()]);

  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  const keys = admissionKeys(sale.id);
  const admission = new RedisAdmission(process.env.TEST_REDIS_URL!);

  try {
    expect(await redis.info('replication')).toContain('connected_slaves:1');
    expect(await replica.info('replication')).toContain(
      'master_link_status:up',
    );
    expect(await replica.info('replication')).toContain('role:slave');
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '1',
      remaining_stock: '1',
      configuration_version: '1',
    });
    await admission.recover(sale, []);
    expect(
      await admission.place(sale.id, {
        identifier: 'person',
        idempotencyKey: 'key',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    await expect
      .poll(() => replica.hGet(keys[1], 'person'), { timeout: 10000 })
      .toBe('key');
    expect(await replica.xLen(keys[4])).toBe(1);
    await expect(
      replica.hSet(keys[0], 'remaining_stock', '100'),
    ).rejects.toThrow('READONLY');
  } finally {
    admission.close();
    redis.destroy();
    replica.destroy();
  }
}, 20000);

it('acknowledges admission while the replica is offline without waiting for replication', async () => {
  const { redis, database } = testServices();

  await database.end();
  await redis.connect();

  const docker = (...args: string[]) =>
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        'compose.test.yaml',
        '-p',
        process.env.TEST_PROJECT!,
        ...args,
      ],
      { timeout: 30000, stdio: 'pipe' },
    );
  const sale = {
    id: randomUUID(),
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    initialStock: 1,
  };
  const keys = admissionKeys(sale.id);
  const admission = new RedisAdmission(process.env.TEST_REDIS_URL!);

  try {
    await redis.hSet(keys[0], {
      starts_at: String(Date.parse(sale.startsAt)),
      ends_at: String(Date.parse(sale.endsAt)),
      initial_stock: '1',
      remaining_stock: '1',
      configuration_version: '1',
    });
    await admission.recover(sale, []);
    docker('stop', 'redis-replica');
    await expect
      .poll(async () =>
        (await redis.info('replication')).includes('connected_slaves:0'),
      )
      .toBe(true);
    expect(
      await admission.place(sale.id, {
        identifier: 'person',
        idempotencyKey: 'key',
      }),
    ).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await redis.xLen(keys[4])).toBe(1);
  } finally {
    admission.close();
    docker('up', '-d', '--wait', 'redis-replica');
    redis.destroy();
  }
}, 60000);
