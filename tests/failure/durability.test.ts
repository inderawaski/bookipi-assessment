import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { DurableAdmission, admissionKeys, admitPurchase, createRedisConnection } from '../../packages/redis/src/index.js';
import { confirmationScript } from '../../packages/redis/src/sales/durability-scripts.js';
import { testServices } from '../services.js';

async function fixture() {
  const { redis, database } = testServices();
  await database.end(); await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), initialStock: 2 };
  const keys = admissionKeys(sale.id);
  await redis.hSet(keys[0], { starts_at: String(Date.parse(sale.startsAt)), ends_at: String(Date.parse(sale.endsAt)), initial_stock: '2', remaining_stock: '2', configuration_version: '1' });
  const gate = new DurableAdmission(process.env.TEST_REDIS_URL!);
  await gate.recover(sale, []);
  return { redis, sale, keys, gate };
}
function docker(...args: string[]) {
  execFileSync('docker', ['compose', '-f', 'compose.test.yaml', '-p', process.env.TEST_PROJECT!, ...args], { timeout: 30000, stdio: 'pipe' });
}
it('proves unrelated WAITAOF is insufficient and a checkpoint covers another client on Redis 7.4.8', async () => {
  const f = await fixture();
  const lookup = createRedisConnection(process.env.TEST_REDIS_URL!, 'durability');
  await lookup.connect();
  try {
    // Drain existing fsync work, then suppress future fsync only in the isolated test instance.
    await f.redis.sendCommand(['WAITAOF', '1', '0', '2000']);
    await f.redis.configSet('appendfsync', 'no');
    await setTimeout(1100);
    const reservation = await admitPurchase(f.redis, f.sale.id, { identifier: 'person', idempotencyKey: 'key' });
    expect(reservation.status).toBe('reserved');
    expect(await lookup.sendCommand(['WAITAOF', '1', '0', '50'])).toEqual([1, 0]);
    expect(await f.redis.sendCommand(['WAITAOF', '1', '0', '50'])).toEqual([0, 0]);
    await lookup.sendCommand(['EVAL', confirmationScript, '5', ...f.keys, 'person', f.sale.id]);
    expect(await lookup.sendCommand(['WAITAOF', '1', '0', '50'])).toEqual([0, 0]);
    const entries = await f.redis.xRange(f.keys[4], '-', '+');
    expect(entries).toHaveLength(1);
    await expect(f.gate.confirmForWorker(f.sale.id, 'person', 'key', entries![0]!.id)).rejects.toThrow('unconfirmed');
    expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'different' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
    await f.redis.configSet('appendfsync', 'everysec');
    expect((await f.gate.lookup(f.sale.id, 'person')).status).toBe('durable');
  } finally {
    await f.redis.configSet('appendfsync', 'everysec');
    lookup.destroy(); f.redis.destroy();
  }
}, 15000);

it.each(['before_lua', 'after_lua', 'during_wait', 'after_confirmation', 'rewrite'] as const)('SIGKILL at %s preserves acknowledged work and fences restart', async boundary => {
  const f = await fixture();
  let pending: Promise<unknown> | undefined;
  try {
    if (boundary === 'after_lua' || boundary === 'during_wait') {
      await f.redis.configSet('appendfsync', 'no');
      await setTimeout(1100);
      await admitPurchase(f.redis, f.sale.id, { identifier: 'person', idempotencyKey: 'key' });
    }
    if (boundary === 'during_wait') {
      pending = f.redis.sendCommand(['WAITAOF', '1', '0', '10000']).catch(() => 'disconnected');
      // The pending call is on a socket that has written; wait until Redis reports it blocked.
      const observer = createRedisConnection(process.env.TEST_REDIS_URL!, 'commands');
      await observer.connect();
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          if ((await observer.info('clients')).includes('blocked_clients:1')) { blocked = true; break; }
          await setTimeout(10);
        }
        expect(blocked).toBe(true);
      } finally { observer.destroy(); }
    }
    const acknowledged = boundary === 'after_confirmation' || boundary === 'rewrite';
    if (acknowledged) {
      // Simulate loss of HTTP response after the library confirms; retry must still find it.
      expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    }
    if (boundary === 'rewrite') {
      // Redis test knob slows each RDB-preamble key so rewrite spans the kill.
      await f.redis.configSet('rdb-key-save-delay', '100000');
      await f.redis.sendCommand(['BGREWRITEAOF']);
      // Kill while rewrite is in progress, not after its completion.
      expect((await f.redis.info('persistence')).includes('aof_rewrite_in_progress:1')).toBe(true);
    }
    docker('kill', '-s', 'SIGKILL', 'redis');
    if (pending) await pending;
    if (f.redis.isOpen) f.redis.destroy();
    docker('up', '-d', '--wait', 'redis');
    await f.redis.connect();
    // Old recovered_run was persisted, but does not match this new process.
    expect(await f.gate.lookup(f.sale.id, 'person')).toEqual({ status: 'confirming', diagnostic: 'durability_unavailable' });
    expect(await f.gate.place(f.sale.id, { identifier: 'other', idempotencyKey: 'other' })).toEqual({ status: 'PROCESSING', phase: 'confirming' });
    await f.gate.recover(f.sale, []);
    const found = await f.gate.lookup(f.sale.id, 'person');
    if (acknowledged) expect(found.status).toBe('durable');
    else expect(['confirming', 'durable']).toContain(found.status);
    const count = await f.redis.hLen(f.keys[3]);
    expect(Number(await f.redis.hGet(f.keys[0], 'remaining_stock')) + count).toBe(2);
    if (found.status === 'confirming') expect(found.diagnostic).toBe('missing_without_absence_proof');
    if (acknowledged) expect(await f.gate.place(f.sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
  } finally { if (f.redis.isOpen) f.redis.destroy(); }
}, 60000);
