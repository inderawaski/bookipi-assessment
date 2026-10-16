import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { migrate, persistSale } from '../../packages/database/src/index.js';
import { RedisAdmission, admissionKeys, initializeAdmission } from '../../packages/redis/dist/index.js';
import { processOrder, orderGroup } from '../../apps/worker/src/orders/consumer.js';
import { testServices } from '../services.js';

async function killAt(mode: string, boundary: string, saleId: string, entry?: unknown) {
  const trace: string[] = [];
  let child: ChildProcess | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child = fork('tests/failure/fixtures/process.mjs', [JSON.stringify({ mode, boundary, saleId, entry })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const timer = setTimeout(() => reject(new Error(`Boundary not reached: ${boundary}`)), 15000);
      child.on('error', reject);
      child.on('exit', () => { clearTimeout(timer); reject(new Error('Child exited before failpoint')); });
      child.on('message', message => {
        const hit = (message as { boundary: string }).boundary;
        trace.push(hit);
        if (hit === boundary) { clearTimeout(timer); resolve(); }
      });
    });
    await new Promise<void>((resolve, reject) => {
      child!.once('exit', (_, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error('Expected abrupt kill')));
      child!.kill('SIGKILL');
    });
    return trace;
  } finally { if (child && child.exitCode === null) child.kill('SIGKILL'); }
}

it.each([
  ['admission', 'before_send'], ['admission', 'after_send'],
  ['admission', 'before_acknowledgement'],
  ...['receipt', 'after_validation', 'before_transaction', 'after_begin', 'before_commit', 'after_commit', 'before_status', 'after_status', 'after_ack'].map(boundary => ['worker', boundary]),
])('SIGKILL %s at %s converges without revoking allocation', async (mode, boundary) => {
  const { database, redis } = testServices();
  await redis.connect();
  const sale = { id: randomUUID(), startsAt: new Date(Date.now() + 2000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), initialStock: 1 };
  const keys = admissionKeys(sale.id);
  const gate = new RedisAdmission(process.env.TEST_REDIS_URL!);
  try {
    await migrate(database); await persistSale(database, sale); await initializeAdmission(redis, sale); await gate.recover(sale, []);
    await expect.poll(async () => {
      const time = await redis.sendCommand(['TIME']) as string[];
      return Number(time[0])*1000 + Math.floor(Number(time[1])/1000) >= Date.parse(sale.startsAt);
    }, { timeout: 5000, interval: 25 }).toBe(true);
    let entry;
    if (mode === 'worker') {
      expect(await gate.place(sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
      await redis.xGroupCreate(keys[4], orderGroup, '0');
      entry = (await redis.xReadGroup(orderGroup, 'crashed', { key: keys[4], id: '>' }))![0]!.messages[0]!;
    }
    const trace = await killAt(mode!, boundary!, sale.id, entry);
    // The client received no reply from the killed process. Absence is never a rejection.
    const missing = await gate.lookup(sale.id, 'missing');
    expect(missing).toEqual({ status: 'confirming', diagnostic: 'missing_without_absence_proof' });
    const before = await database.query('SELECT id FROM "order" WHERE flash_sale_id=$1', [sale.id]);
    if (mode === 'worker') expect(before.rowCount).toBe(['after_commit', 'before_status', 'after_status', 'after_ack'].includes(boundary!) ? 1 : 0);
    expect(await gate.place(sale.id, { identifier: 'person', idempotencyKey: 'key' })).toEqual({ status: 'PROCESSING', phase: 'queued' });
    expect(await gate.place(sale.id, { identifier: 'rejected', idempotencyKey: 'rejected' })).toEqual({ status: 'REJECTED', reason: 'sold_out' });
    if (mode === 'admission') {
      await redis.xGroupCreate(keys[4], orderGroup, '0');
      entry = (await redis.xReadGroup(orderGroup, 'recovery', { key: keys[4], id: '>' }))![0]!.messages[0]!;
    } else if (boundary !== 'after_ack') {
      const claimed = await redis.xAutoClaim(keys[4], orderGroup, 'recovery', 0, '0-0');
      expect(claimed.messages).toHaveLength(1);
      entry = claimed.messages[0]!;
    }
    await processOrder(database, redis, gate, sale.id, entry!);
    await processOrder(database, redis, gate, sale.id, entry!);
    const orders = await database.query('SELECT id, user_identifier, admitted_at FROM "order" WHERE flash_sale_id=$1', [sale.id]);
    await gate.recover(sale, orders.rows.map(r => ({ orderId: r.id, identifier: r.user_identifier, admittedAtMs: r.admitted_at.getTime() })));
    expect(orders.rows.map(r => r.user_identifier)).toEqual(['person']);
    expect(await redis.hLen(keys[3])).toBe(1);
    expect(await redis.hGet(keys[0], 'remaining_stock')).toBe('0');
    expect(await redis.xLen(keys[4])).toBe(1);
    expect((await redis.xPending(keys[4], orderGroup)).pending).toBe(0);
    expect(await redis.hGet(`${keys[0]}:completed`, 'person')).toBe(orders.rows[0]!.id);
    expect(await gate.place(sale.id, { identifier: 'rejected', idempotencyKey: 'rejected' })).toEqual({ status: 'REJECTED', reason: 'sold_out' });
    const directory = `test-results/failure/${process.env.TEST_PROJECT}`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/${mode}-${boundary}.json`, JSON.stringify({ saleId: sale.id, trace, signal: 'SIGKILL', orders: orders.rows, reservations: 1, remaining: 0, pending: 0 }, null, 2));
  } finally { redis.destroy(); await database.end(); }
}, 30000);
