import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createDatabase, migrate, persistSale } from '../../packages/database/dist/index.js';
import { createRedisConnection, assertRedisSafety, initializeAdmission, admissionKeys } from '../../packages/redis/dist/index.js';
import { burst } from './generator.mjs';
import { scenarios, validateFinal } from './accounting.mjs';

const scenario = scenarios.find(s => s.name === process.argv[2]);
if (!scenario || !/^flash-test-[0-9a-f-]{36}$/.test(process.env.TEST_PROJECT ?? '') || new URL(process.env.TEST_DATABASE_URL).pathname !== '/flash_test') throw new Error('Use pnpm test:stress for isolated test data');
const database = createDatabase(process.env.TEST_DATABASE_URL, 2, 5000);
const redis = createRedisConnection(process.env.TEST_REDIS_URL, 'commands', 5000);
const output = process.env.STRESS_OUTPUT;
const artifact = { scenario, commit: process.env.STRESS_COMMIT, settings: { connections: Number(process.env.STRESS_CONNECTIONS || Math.min(scenario.requests, 10000)), timeoutMs: 30000, drainTimeoutMs: 120000, dispatchWindowMs: 1000, scheduleWindowMs: 900 }, startedAt: new Date().toISOString() };
async function metrics(base) {
  const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Metrics unavailable');
  return response.text();
}
try {
  await redis.connect(); await assertRedisSafety(redis); await migrate(database);
  const clock = await redis.sendCommand(['TIME']);
  const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
  const sale = await persistSale(database, { id: randomUUID(), startsAt: new Date(now + 10000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), initialStock: scenario.stock });
  artifact.sale = sale;
  await initializeAdmission(redis, sale);
  // Explicit probes discover this sale before the burst; neither places an order.
  for (const base of [process.env.STRESS_API, process.env.STRESS_WORKER]) {
    const ready = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(10000) });
    if (!ready.ok) throw new Error('Service reconciliation failed');
  }
  artifact.metricsBefore = { api: await metrics(process.env.STRESS_API), worker: await metrics(process.env.STRESS_WORKER) };
  while (true) {
    const time = await redis.sendCommand(['TIME']);
    if (Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) >= Date.parse(sale.startsAt)) break;
    await delay(25);
  }
  artifact.burst = await burst(process.env.STRESS_API, sale.id, scenario, artifact.settings);
  const drainStarted = performance.now();
  const keys = admissionKeys(sale.id);
  let entries, allocations, orders, pending;
  do {
    entries = await redis.xRange(keys[4], '-', '+');
    allocations = await redis.hGetAll(keys[1]);
    orders = (await database.query('SELECT id, user_identifier, admitted_at FROM "order" WHERE flash_sale_id=$1', [sale.id])).rows;
    try { pending = (await redis.xPending(keys[4], 'orders')).pending; }
    catch (error) { if (!error.message.includes('NOGROUP')) throw error; pending = entries.length; }
    if (orders.length === entries.length && pending === 0) break;
    await delay(100);
  } while (performance.now() - drainStarted < artifact.settings.drainTimeoutMs);
  artifact.queueDrainMs = performance.now() - drainStarted;
  const stockValue = await redis.hGet(keys[0], 'remaining_stock');
  const remainingStock = stockValue === null ? NaN : Number(stockValue);
  const acknowledged = new Set(artifact.burst.records.filter(r => r.response?.status === 'SUCCESS' || (r.response?.status === 'PROCESSING' && ['queued', 'delayed'].includes(r.response.phase))).map(r => r.input.identifier));
  const final = { entries, allocations, orders, pending, remainingStock };
  artifact.final = { ...final, invariants: validateFinal(scenario.stock, final, acknowledged) };
  artifact.metricsAfter = { api: await metrics(process.env.STRESS_API), worker: await metrics(process.env.STRESS_WORKER) };
  artifact.redisPersistence = await redis.info('persistence');
  artifact.runStatus = artifact.burst.validDispatch ? 'valid_dispatch' : 'invalid_generator';
  artifact.passed = artifact.burst.validDispatch && Object.values(artifact.final.invariants).every(Boolean);
  if (!artifact.passed) process.exitCode = 1;
} catch (error) {
  if (error.measurement) artifact.burst = error.measurement;
  artifact.error = error.stack;
  artifact.runStatus = error.measurement ? 'invalid_generator' : artifact.burst ? 'measurement_failed' : 'invalid_generator_or_setup';
  artifact.passed = false;
  process.exitCode = 1;
} finally {
  writeFileSync(`${output}/result.json`, JSON.stringify(artifact, null, 2));
  if (redis.isOpen) redis.destroy();
  await database.end();
}
