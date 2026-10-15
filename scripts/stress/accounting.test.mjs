import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inputs, scenarios, summarize, validateFinal, resourceSample } from './accounting.mjs';
import { burst } from './generator.mjs';

test('prescribed cases and duplicate keys have exact cardinality', () => {
  assert.deepEqual(scenarios.slice(0, 5).map(s => [s.stock, s.requests, s.identifiers]), [[100, 1000, 1000], [100, 10000, 10000], [100, 10000, 100], [100, 100000, 100000], [10000, 100000, 100000]]);
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
