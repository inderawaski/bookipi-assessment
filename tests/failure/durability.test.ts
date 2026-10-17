import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { RedisAdmission, admissionKeys } from '../../packages/redis/src/index.js';
import { testServices } from '../services.js';

async function fixture() {
  const { redis, database } = testServices();
  await database.end(); await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), initialStock: 2 };
  const keys = admissionKeys(sale.id);
  await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '2', remaining_stock: '2', configuration_version: '1' });
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
  await gate.recover(sale, []);
  // Establish older configuration state before exercising loss of a newer admission.
  // This is test setup, not an admission persistence guarantee.
  await setTimeout(1200);
  return { redis, sale, keys, gate };
}
function docker(...args: string[]) {
  execFileSync('docker', ['compose', '-f', 'compose.test.yaml', '-p', process.env.TEST_PROJECT!, ...args], { timeout: 30000, stdio: 'pipe' });
}
it.each(['before_lua', 'after_acknowledgement', 'rewrite'] as const)('SIGKILL at %s fences restart and reconciles whatever admission state survived', async boundary => {
  const f = await fixture();
  try {
    if (boundary !== 'before_lua') {
      expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    }
    if (boundary === 'rewrite') {
      await f.redis.configSet('rdb-key-save-delay', '100000');
      await f.redis.sendCommand(['BGREWRITEAOF']);
      expect((await f.redis.info('persistence')).includes('aof_rewrite_in_progress:1')).toBe(true);
    }
    docker('kill', '-s', 'SIGKILL', 'redis');
    if (f.redis.isOpen) f.redis.destroy();
    docker('up', '-d', '--wait', 'redis');
    await f.redis.connect();
    expect(await f.gate.lookup(f.sale.id, 'person')).toEqual({ status: 'confirming', diagnostic: 'admission_unavailable' });
    await f.gate.recover(f.sale, []);
    const found = await f.gate.lookup(f.sale.id, 'person');
    // Without persistence/replica acknowledgement, neither survival nor loss is promised.
    expect(['confirming', 'present']).toContain(found.status);
    const count = await f.redis.hLen(f.keys[3]);
    expect(Number(await f.redis.hGet(f.keys[0], 'remaining_stock')) + count).toBe(2);
    if (found.status === 'confirming') expect(found.diagnostic).toBe('missing_without_absence_proof');
    expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await f.redis.xLen(f.keys[4])).toBe(1);
  } finally { f.gate.close(); if (f.redis.isOpen) f.redis.destroy(); }
}, 60000);
