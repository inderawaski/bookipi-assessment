import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createDatabase, migrate, persistSale } from '../../packages/database/dist/index.js';
import { createRedisConnection, assertRedisSafety, initializeAdmission, admissionKeys } from '../../packages/redis/dist/index.js';
import { burst } from './generator.mjs';
import { scenarios, validateFinal, admissionsWithinWindow, orderLatency, allBusinessResponses } from './accounting.mjs';
import { waitForRedisTime, pollStatus } from './support.mjs';
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
try {
  await redis.connect(); await assertRedisSafety(redis); await migrate(database);
  const clock = await redis.sendCommand(['TIME']);
  const now = Number(clock[0]) * 1000 + Math.floor(Number(clock[1]) / 1000);
  const sale = await persistSale(database, { id: randomUUID(), startsAt: new Date(now + 10000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), initialStock: scenario.stock });
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
  const settings = { ...artifact.settings,
    beforeDispatch: async () => { artifact.redisTimeAtDispatch = await waitForRedisTime(redis, Date.parse(sale.startsAt)); },
    onDispatch: () => {
      artifact.dispatchStartedAt = new Date().toISOString();
      if (scenario.orderSlo || scenario.measureOrders) observer = (async () => {
        while (!stopObserving) {
          await observeOrders(sale.id);
          await delay(25);
        }
      })().catch(error => { artifact.observationError = String(error); });
      stopPolling = pollStatus(process.env.STRESS_API, sale.id, artifact.polls);
    },
  };
  artifact.burst = await burst(process.env.STRESS_API, sale.id, scenario, settings);
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
  const acknowledged = new Set(artifact.burst.records.filter(r => r.response?.status === 'SUCCESS' || (r.response?.status === 'PROCESSING' && ['queued', 'delayed'].includes(r.response.phase))).map(r => r.input.identifier));
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
  if (scenario.orderSlo) artifact.final.invariants.allRequestsHaveBusinessResponses =
    allBusinessResponses(artifact.burst.records, scenario.requests);
  artifact.apiReplicaMetricsAfter = await Promise.all(JSON.parse(process.env.STRESS_API_ENDPOINTS || '[]').map(metrics));
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
  stopObserving = true;
  if (observer) await observer;
  if (stopPolling) await stopPolling();
  writeFileSync(`${output}/result.json`, JSON.stringify(artifact, null, 2));
  if (redis.isOpen) redis.destroy();
  await database.end();
}
