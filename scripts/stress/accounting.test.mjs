import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inputs, scenarios, summarize, validateFinal, resourceSample, admissionsWithinWindow, orderLatency } from './accounting.mjs';
import { burst } from './generator.mjs';

test('prescribed cases and duplicate keys have exact cardinality', () => {
  assert.deepEqual(scenarios.slice(0, 7).map(s => [s.stock, s.requests, s.identifiers]), [[10, 100, 100], [10, 100, 10], [1000, 1000, 1000], [100, 5000, 5000], [100, 5000, 5000], [100, 5000, 5000], [100, 10000, 10000]]);
  for (const scenario of scenarios) {
    const records = inputs(scenario);
    assert.equal(new Set(records.map(r => r.identifier)).size, scenario.identifiers);
    assert.equal(new Set(records.map(r => r.idempotencyKey)).size, scenario.sameKey ? scenario.identifiers : scenario.requests);
  }
});
test('late responses do not invalidate timely dispatch; latency and outcomes account exactly', () => {
  const summary = summarize([{ index: 0, scheduledMs: 0, dispatchMs: 1, completedMs: 1501, outcome: 'PROCESSING:queued' }, { index: 1, scheduledMs: 500, dispatchMs: 501, completedMs: 551, outcome: 'REJECTED:busy' }], 2);
  assert.equal(summary.validDispatch, true);
  assert.equal(summary.allResponsesWithinOneSecond, false);
  assert.deepEqual(summary.latencyMs, { p50: 50, p95: 1500, p99: 1500 });
  assert.equal(Object.values(summary.outcomes).reduce((a, b) => a + b), 2);
});
test('missing, late, duplicate and inconsistent dispatch evidence invalidates runs', () => {
  assert.equal(summarize([{ index: 0, scheduledMs: 0, outcome: 'transport_error' }], 1).validDispatch, false);
  assert.equal(summarize([{ index: 0, scheduledMs: 0, dispatchMs: 1000 }], 1).validDispatch, false);
  assert.equal(summarize([{ index: 0, scheduledMs: 0, dispatchMs: 0 }, { index: 0, scheduledMs: 0, dispatchMs: 1 }], 2).validDispatch, false);
  assert.equal(summarize([{ index: 0, scheduledMs: 0, dispatchMs: 2, completedMs: 1 }], 1).validDispatch, false);
  assert.equal(summarize([], 1).droppedIterations, 1);
});
test('real socket evidence detects acquisition stretch after iteration starts', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push(performance.now());
      setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{"status":"PROCESSING","phase":"queued"}'); }, 1100);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await burst(`http://127.0.0.1:${server.address().port}`, 'sale', { requests: 2, identifiers: 2 }, { connections: 1 });
    assert.equal(result.dispatched, 2);
    assert.equal(result.completed, 2);
    assert.equal(result.validDispatch, false);
    assert.ok(result.invalidReasons.includes('dispatch_outside_window'));
    assert.ok(received[1] - received[0] >= 1000);
    assert.ok(result.records[1].scheduledMs < 1000);
    assert.ok(result.records[1].dispatchMs >= 1000);
    assert.ok(result.generator.bytesWritten > 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('preconnected clients reach a real server in the dispatch window', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    request.resume(); request.on('end', () => { received.push(performance.now()); response.end('{"status":"REJECTED","reason":"busy"}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await burst(`http://127.0.0.1:${server.address().port}`, 'sale', { requests: 10, identifiers: 10 });
    assert.equal(result.validDispatch, true);
    assert.equal(received.length, 10);
    assert.ok(Math.max(...received) - Math.min(...received) < 1000);
    assert.equal(result.completed, 10);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('final accounting detects oversell, loss, duplicates, mismatches and an undrained queue', () => {
  const final = { entries: [{ message: { identifier: 'person', request_key: 'key', admitted_at_ms: '1000' } }], allocations: { person: 'key' },
    orders: [{ user_identifier: 'person', admitted_at: new Date(1000).toISOString() }], pending: 0, remainingStock: 0 };
  assert.ok(Object.values(validateFinal(1, final, ['person'])).every(Boolean));
  assert.equal(validateFinal(0, final, []).noOversell, false);
  assert.equal(validateFinal(1, { ...final, orders: [] }, ['person']).acknowledgedPreserved, false);
  assert.equal(validateFinal(1, { ...final, orders: [...final.orders, ...final.orders] }, []).uniqueOrders, false);
  assert.equal(validateFinal(1, { ...final, allocations: { person: 'wrong' } }, []).mappingsMatch, false);
  assert.equal(validateFinal(1, { ...final, remainingStock: 1 }, []).stockConserved, false);
  assert.equal(validateFinal(1, { ...final, pending: 1 }, []).drained, false);
  assert.equal(validateFinal(1, { ...final, orders: [{ user_identifier: 'other', admitted_at: new Date(1000) }] }, []).ordersMatchAdmissions, false);
});


test('Docker terminal control sequences are removed from machine-readable samples', () => {
  const sample = resourceSample('\u001b[2J\u001b[H{"CPUPerc":"12.0%"}');
  assert.equal(sample.CPUPerc, '12.0%');
  assert.ok(sample.sampledAt);
  assert.equal(resourceSample('\u001b[H'), null);
  assert.throws(() => resourceSample('not JSON'));
});

test('admission window includes opening and excludes closing, even after recovery', () => {
  const sale = { startsAt: new Date(1000).toISOString(), endsAt: new Date(2000).toISOString() };
  const entries = time => [{ message: { admitted_at_ms: String(time) } }];
  assert.equal(admissionsWithinWindow(entries(1000), sale), true);
  assert.equal(admissionsWithinWindow(entries(1999), sale), true);
  assert.equal(admissionsWithinWindow(entries(999), sale), false);
  assert.equal(admissionsWithinWindow(entries(2000), sale), false);
  assert.equal(admissionsWithinWindow(entries(NaN), sale), false);
});

test('dispatch hook runs after preconnect and before any request is written', async () => {
  let ready = false, started = false;
  const server = http.createServer((request, response) => {
    assert.ok(ready && started);
    request.resume();
    response.end('{"status":"REJECTED","reason":"busy"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await burst(`http://127.0.0.1:${server.address().port}`, 'sale', { requests: 2, identifiers: 2 }, {
      beforeDispatch: async () => { await new Promise(resolve => setTimeout(resolve, 20)); ready = true; },
      onDispatch: () => { assert.ok(ready); started = true; },
    });
    assert.equal(result.validDispatch, true);
    assert.equal(result.completed, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('closed preconnected sockets retain failed queued request accounting', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader('Connection', 'close');
    setTimeout(() => response.end('{"status":"REJECTED","reason":"busy"}'), 200);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await burst(`http://127.0.0.1:${server.address().port}`, 'sale', { requests: 100, identifiers: 100 }, { connections: 10, timeoutMs: 2000 });
    assert.equal(result.records.length, 100);
    assert.equal(result.validDispatch, false);
    assert.ok(result.outcomes.transport_error > 0);
    assert.equal(Object.values(result.outcomes).reduce((sum, count) => sum + count, 0), 100);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('order SLO rejects missing observations, empty admissions and exact p99 boundary', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ message: { identifier: String(i), admitted_at_ms: '1000' } }));
  const observed = Object.fromEntries(entries.map(e => [e.message.identifier, 2999]));
  observed['99'] = 11000;
  assert.ok(Object.values(orderLatency(entries, observed).invariants).every(Boolean));
  observed['98'] = 3000;
  assert.equal(orderLatency(entries, observed).invariants.orderP99UnderTwoSeconds, false);
  observed['99'] = 11001;
  assert.equal(orderLatency(entries, observed).invariants.allOrdersWithinTenSeconds, false);
  delete observed['0'];
  assert.equal(orderLatency(entries, observed).invariants.orderLatencyObserved, false);
  assert.equal(orderLatency([], {}).invariants.orderLatencyObserved, false);
});
test('dispatch validity uses each workload window independently of one-second response metric', () => {
  const records = [{ index: 0, scheduledMs: 2000, dispatchMs: 2999, completedMs: 4000 }];
  assert.equal(summarize(records, 1, 3000).validDispatch, true);
  assert.equal(summarize(records, 1, 3000).allResponsesWithinOneSecond, false);
  assert.equal(summarize(records, 1, 3000).allResponsesWithinWindow, false);
  assert.equal(summarize(records, 1, 1000).validDispatch, false);
});

test('generator honors synchronized release and custom arrival windows over real HTTP', async t => {
  const server = http.createServer((_req, res) => { res.end('{"status":"SUCCESS"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scenario = { requests: 3, identifiers: 3, dispatchWindowMs: 200, scheduleWindowMs: 100 };
  const paced = await burst(base, 'sale', scenario);
  assert.deepEqual(paced.records.map(r => r.scheduledMs), [0, 100 / 3, 200 / 3]);
  assert.equal(paced.validDispatch, true);
  const synchronized = await burst(base, 'sale', { ...scenario, scheduleWindowMs: 0 });
  assert.deepEqual(synchronized.records.map(r => r.scheduledMs), [0, 0, 0]);
  assert.equal(synchronized.validDispatch, true);
});

test('optional two-second spike changes arrival window while preserving stock and order gates', () => {
  const baseline = scenarios.find(s => s.name === 'spike-10k');
  const comparison = scenarios.find(s => s.name === 'spike-10k-2s');
  assert.equal(comparison.optional, true);
  assert.equal(comparison.dispatchWindowMs, 2000);
  for (const field of ['stock', 'requests', 'identifiers', 'expectFill', 'orderSlo']) assert.equal(comparison[field], baseline[field]);
});
