import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createDatabase, migrate, persistSale } from '../../packages/database/dist/index.js';
import { createRedisConnection, assertRedisSafety, initializeAdmission, admissionKeys } from '../../packages/redis/dist/index.js';
import { burst } from './generator.mjs';
import { scenarios, validateFinal, admissionsWithinWindow, orderLatency } from './accounting.mjs';
import { waitForRedisTime, crashWorker, pollStatus } from './experiments.mjs';
import { waitForReadiness } from './readiness.mjs';

const scenario = scenarios.find(s => s.name === process.argv[2]);
if (!scenario || !/^flash-test-[0-9a-f-]{36}$/.test(process.env.TEST_PROJECT ?? '') || new URL(process.env.TEST_DATABASE_URL).pathname !== '/flash_test') throw new Error('Use pnpm test:stress for isolated test data');
const database = createDatabase(process.env.TEST_DATABASE_URL, 2, 5000);
const redis = createRedisConnection(process.env.TEST_REDIS_URL, 'commands', 5000);
const output = process.env.STRESS_OUTPUT;
const artifact = { scenario, commit: process.env.STRESS_COMMIT, settings: { connections: Number(process.env.STRESS_CONNECTIONS || Math.min(scenario.requests, 10000)), timeoutMs: 30000, drainTimeoutMs: 300000, dispatchWindowMs: scenario.dispatchWindowMs ?? 1000, scheduleWindowMs: scenario.scheduleWindowMs ?? (scenario.dispatchWindowMs ?? 1000) * 0.9 }, startedAt: new Date().toISOString() };
async function observeOrders(saleId) {
  const rows = (await database.query(`SELECT user_identifier,
    extract(epoch FROM clock_timestamp()) * 1000 AS observed_ms
    FROM "order" WHERE flash_sale_id=$1`, [saleId])).rows;
  for (const row of rows) observedOrders[row.user_identifier] ??= Number(row.observed_ms);
}
async function metrics(base) {
  const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Metrics unavailable');
  return response.text();
}
let stopPolling;
let stopObserving = false;
let observer;
const observedOrders = {};
let recovery;
let workerBase = process.env.STRESS_WORKER;
try {
  await redis.connect(); await assertRedisSafety(redis); await migrate(database);
  const clock = await redis.sendCommand(['TIME']);
  const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
  const sale = await persistSale(database, { id: randomUUID(), startsAt: new Date(now + 10000).toISOString(), endsAt: new Date(now + (scenario.boundary ? 20000 : 3600000)).toISOString(), initialStock: scenario.stock });
  artifact.sale = sale;
  await initializeAdmission(redis, sale);
  // Discover the new sale on every replica before starting the dispatch clock.
  artifact.readinessAttempts = [];
  const apiEndpoints = JSON.parse(process.env.STRESS_API_ENDPOINTS || JSON.stringify([process.env.STRESS_API]));
  const workerEndpoints = JSON.parse(process.env.STRESS_WORKER_ENDPOINTS || JSON.stringify([process.env.STRESS_WORKER]));
  await waitForReadiness([...apiEndpoints, ...workerEndpoints], { onAttempt: attempt => artifact.readinessAttempts.push(attempt) });
  artifact.apiReplicaMetricsBefore = await Promise.all(JSON.parse(process.env.STRESS_API_ENDPOINTS || '[]').map(metrics));
  artifact.metricsBefore = { api: await metrics(process.env.STRESS_API), worker: await metrics(process.env.STRESS_WORKER) };
  artifact.polls = [];
  artifact.failureEvents = [];
  const target = scenario.boundary === 'opening' ? Date.parse(sale.startsAt) - 450 :
    scenario.boundary === 'closing' ? Date.parse(sale.endsAt) - 450 : Date.parse(sale.startsAt);
  const settings = { ...artifact.settings,
    beforeDispatch: async () => { artifact.redisTimeAtDispatch = await waitForRedisTime(redis, target); },
    onDispatch: () => {
      artifact.dispatchStartedAt = new Date().toISOString();
      if (scenario.orderSlo || scenario.measureOrders) observer = (async () => {
        while (!stopObserving) {
          await observeOrders(sale.id);
          await delay(25);
        }
      })().catch(error => { artifact.observationError = String(error); });
      stopPolling = pollStatus(process.env.STRESS_API, sale.id, artifact.polls);
      if (scenario.failure) recovery = crashWorker(JSON.parse(process.env.STRESS_COMPOSE_ARGS), artifact.failureEvents)
        .then(base => { workerBase = base; }, error => { artifact.recoveryError = String(error); });
    },
  };
  artifact.burst = await burst(process.env.STRESS_API, sale.id, scenario, settings);
  artifact.repeatedBursts = [];
  for (let i = 1; i < (scenario.repeats ?? 1); i++) {
    artifact.repeatedBursts.push(await burst(process.env.STRESS_API, sale.id, scenario, artifact.settings));
  }
  if (recovery) await recovery;
  const drainStarted = performance.now();
  const keys = admissionKeys(sale.id);
  let entries, allocations, orders, pending;
  artifact.drainSamples = [];
  do {
    entries = await redis.xRange(keys[4], '-', '+');
    allocations = await redis.hGetAll(keys[1]);
    orders = (await database.query('SELECT id, user_identifier, admitted_at, completed_at FROM "order" WHERE flash_sale_id=$1', [sale.id])).rows;
    try { pending = (await redis.xPending(keys[4], 'orders')).pending; }
    catch (error) { if (!error.message.includes('NOGROUP')) throw error; pending = entries.length; }
    artifact.drainSamples.push({ elapsedMs: performance.now() - drainStarted, admissions: entries.length, orders: orders.length, pending });
    if (orders.length === entries.length && pending === 0) break;
    await delay(100);
  } while (performance.now() - drainStarted < artifact.settings.drainTimeoutMs);
  artifact.queueDrainMs = performance.now() - drainStarted;
  const stockValue = await redis.hGet(keys[0], 'remaining_stock');
  const remainingStock = stockValue === null ? NaN : Number(stockValue);
  const acknowledged = new Set([artifact.burst, ...artifact.repeatedBursts].flatMap(b => b.records).filter(r => r.response?.status === 'SUCCESS' || (r.response?.status === 'PROCESSING' && ['queued', 'delayed'].includes(r.response.phase))).map(r => r.input.identifier));
  const final = { entries, allocations, orders, pending, remainingStock };
  artifact.final = { ...final, invariants: { ...validateFinal(scenario.stock, final, acknowledged),
    admissionsWithinWindow: admissionsWithinWindow(entries, sale),
  } };
  if (scenario.orderSlo || scenario.measureOrders) {
    stopObserving = true;
    await observer;
    await observeOrders(sale.id);
    artifact.orderVisibility = { observedOrders, ...orderLatency(entries, observedOrders) };
    if (scenario.orderSlo) Object.assign(artifact.final.invariants, artifact.orderVisibility.invariants,
      { orderObserverHealthy: !artifact.observationError });
  }
  if (scenario.expectFill) artifact.final.invariants.filled = orders.length === Math.min(scenario.stock, scenario.identifiers);
  if (scenario.boundary) {
    const boundary = Date.parse(scenario.boundary === 'opening' ? sale.startsAt : sale.endsAt);
    const writes = artifact.burst.records.filter(record => Number.isFinite(record.dispatchMs)).map(record => artifact.redisTimeAtDispatch + record.dispatchMs);
    artifact.final.invariants.boundaryStraddled = writes.some(time => time < boundary) && writes.some(time => time >= boundary);
    if (scenario.failure) artifact.final.invariants.completedAfterEnd = orders.some(order => new Date(order.completed_at).getTime() >= Date.parse(sale.endsAt));
    await waitForRedisTime(redis, Date.parse(sale.endsAt));
    const entry = entries[0];
    if (entry) {
      const response = await fetch(`${process.env.STRESS_API}/sales/${sale.id}/purchases`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ identifier: entry.message.identifier, idempotencyKey: entry.message.request_key }),
      });
      artifact.replayAfterEnd = await response.json();
      const status = await fetch(`${process.env.STRESS_API}/sales/${sale.id}/order?identifier=${encodeURIComponent(entry.message.identifier)}`, { signal: AbortSignal.timeout(10000) });
      artifact.statusAfterEnd = await status.json();
      artifact.final.invariants.replayAfterEnd = ['PROCESSING', 'SUCCESS'].includes(artifact.replayAfterEnd.status) && artifact.statusAfterEnd.order?.status === 'SUCCESS';
    } else artifact.final.invariants.replayAfterEnd = false;
    const fresh = await fetch(`${process.env.STRESS_API}/sales/${sale.id}/purchases`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ identifier: 'post-close', idempotencyKey: 'post-close' }),
    });
    artifact.newAfterEnd = await fresh.json();
    artifact.final.invariants.newAfterEndRejected = artifact.newAfterEnd.status === 'REJECTED' && artifact.newAfterEnd.reason === 'ended' &&
      await redis.xLen(keys[4]) === entries.length;
  }
  if (scenario.failure) {
    artifact.final.invariants.recovered = !artifact.recoveryError && artifact.failureEvents.some(event => event.event === 'recovered');
    const killedAt = Date.parse(artifact.failureEvents.find(event => event.event === 'killed')?.at);
    artifact.final.invariants.failureDuringDispatch = killedAt >= Date.parse(artifact.dispatchStartedAt) &&
      killedAt < Date.parse(artifact.dispatchStartedAt) + artifact.settings.dispatchWindowMs;
  }
  artifact.apiReplicaMetricsAfter = await Promise.all(JSON.parse(process.env.STRESS_API_ENDPOINTS || '[]').map(metrics));
  artifact.metricsAfter = { api: await metrics(process.env.STRESS_API), worker: await metrics(workerBase) };
  artifact.redisPersistence = await redis.info('persistence');
  artifact.runStatus = [artifact.burst, ...artifact.repeatedBursts].every(b => b.validDispatch) ? 'valid_dispatch' : 'invalid_generator';
  artifact.passed = artifact.burst.validDispatch && artifact.repeatedBursts.every(b => b.validDispatch) && Object.values(artifact.final.invariants).every(Boolean);
  if (!artifact.passed) process.exitCode = 1;
} catch (error) {
  if (error.measurement) artifact.burst = error.measurement;
  artifact.error = error.stack;
  artifact.runStatus = error.measurement ? 'invalid_generator' : artifact.burst ? 'measurement_failed' : 'invalid_generator_or_setup';
  artifact.passed = false;
  process.exitCode = 1;
} finally {
  stopObserving = true;
  if (observer) await observer;
  if (recovery) await recovery;
  if (stopPolling) await stopPolling();
  writeFileSync(`${output}/result.json`, JSON.stringify(artifact, null, 2));
  if (redis.isOpen) redis.destroy();
  await database.end();
}
