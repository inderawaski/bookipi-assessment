import { stripVTControlCharacters } from 'node:util';
export const scenarios = [
  { name: 'no-oversell', stock: 10, requests: 100, identifiers: 100, scheduleWindowMs: 0 },
  { name: 'duplicates', stock: 10, requests: 100, identifiers: 10, scheduleWindowMs: 0 },
  { name: 'sufficient-stock', stock: 1000, requests: 1000, identifiers: 1000, measureOrders: true },
  { name: 'burst-10s', stock: 100, requests: 5000, identifiers: 5000, dispatchWindowMs: 10000 },
  { name: 'burst-3s', stock: 100, requests: 5000, identifiers: 5000, dispatchWindowMs: 3000 },
  { name: 'burst-1s', stock: 100, requests: 5000, identifiers: 5000 },
  { name: 'spike-10k', stock: 100, requests: 10000, identifiers: 10000, expectFill: true, orderSlo: true },
  { name: 'same-key-retries', stock: 10, requests: 100, identifiers: 10, sameKey: true, scheduleWindowMs: 0 },
  { name: 'healthy', stock: 8, requests: 8, identifiers: 8, expectFill: true },
  { name: 'closing-worker-crash', stock: 1000, requests: 1000, identifiers: 1000, boundary: 'closing', failure: 'worker' },
  { name: 'opening', stock: 16, requests: 16, identifiers: 16, boundary: 'opening' },
  { name: 'closing', stock: 1000, requests: 1000, identifiers: 1000, boundary: 'closing' },
  { name: 'worker-crash', stock: 1000, requests: 1000, identifiers: 1000, failure: 'worker' },
  { name: 'repeated', stock: 1000, requests: 1000, identifiers: 1000, repeats: 3 },
];
export function inputs(scenario) {
  return Array.from({ length: scenario.requests }, (_, i) => ({ identifier: `person-${i % scenario.identifiers}`,
    idempotencyKey: `request-${scenario.sameKey ? i % scenario.identifiers : i}` }));
}
function percentiles(values) {
  values.sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, values.length ? values[Math.ceil(values.length * p / 100) - 1] : null]));
}
export function summarize(records, offered, windowMs = 1000) {
  const dispatched = records.filter(r => Number.isFinite(r.dispatchMs));
  const completed = records.filter(r => Number.isFinite(r.completedMs));
  const reasons = [];
  if (records.length !== offered || new Set(records.map(r => r.index)).size !== offered) reasons.push('accounting_mismatch');
  if (dispatched.length !== offered) reasons.push('missing_dispatch');
  if (dispatched.some(r => r.dispatchMs < 0 || r.dispatchMs >= windowMs)) reasons.push('dispatch_outside_window');
  if (records.some(r => r.scheduledMs < 0 || r.scheduledMs >= windowMs)) reasons.push('schedule_outside_window');
  if (records.some(r => r.completedMs != null && (r.dispatchMs == null || r.completedMs < r.dispatchMs))) reasons.push('invalid_timestamps');
  const outcomes = {};
  for (const r of records) outcomes[r.outcome ?? 'incomplete'] = (outcomes[r.outcome ?? 'incomplete'] ?? 0) + 1;
  return { validDispatch: reasons.length === 0, invalidReasons: reasons, offered, dispatched: dispatched.length,
    completed: completed.length, droppedIterations: offered - dispatched.length, outcomes,
    allResponsesWithinOneSecond: completed.length === offered && completed.every(r => r.completedMs < 1000),
    allResponsesWithinWindow: completed.length === offered && completed.every(r => r.completedMs < windowMs),
    dispatchLastMs: dispatched.length ? dispatched.reduce((max, r) => Math.max(max, r.dispatchMs), 0) : null,
    latencyMs: percentiles(completed.filter(r => r.dispatchMs != null).map(r => r.completedMs - r.dispatchMs)) };
}

export function validateFinal(stock, { entries, allocations, orders, pending, remainingStock }, acknowledged) {
  const orderIdentifiers = new Set(orders.map(o => o.user_identifier));
  const orderByIdentifier = new Map(orders.map(o => [o.user_identifier, o]));
  return {
    noOversell: entries.length <= stock && orders.length <= stock,
    uniqueAllocations: new Set(entries.map(e => e.message.identifier)).size === entries.length && Object.keys(allocations).length === entries.length,
    stockConserved: remainingStock >= 0 && remainingStock === stock - entries.length,
    mappingsMatch: entries.every(e => allocations[e.message.identifier] === e.message.request_key),
    uniqueOrders: orderIdentifiers.size === orders.length,
    drained: orders.length === entries.length && pending === 0,
    ordersMatchAdmissions: orders.length === entries.length && entries.every(e => new Date(orderByIdentifier.get(e.message.identifier)?.admitted_at).getTime() === Number(e.message.admitted_at_ms)),
    acknowledgedPreserved: [...acknowledged].every(identifier => orderIdentifiers.has(identifier)),
  };
}


export function resourceSample(line) {
  const clean = stripVTControlCharacters(line).trim();
  return clean ? { sampledAt: new Date().toISOString(), ...JSON.parse(clean) } : null;
}

export function admissionsWithinWindow(entries, sale) {
  return entries.every(entry => Number(entry.message.admitted_at_ms) >= Date.parse(sale.startsAt) &&
    Number(entry.message.admitted_at_ms) < Date.parse(sale.endsAt));
}

// Visibility is observed after commit, on the PostgreSQL clock. This upper bound
// includes sampling delay; completed_at is assigned before COMMIT and is unsuitable.
export function orderLatency(entries, observations) {
  const values = entries.map(entry => Number(observations[entry.message.identifier]) - Number(entry.message.admitted_at_ms));
  const complete = values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0);
  const latencyMs = percentiles(values.filter(value => Number.isFinite(value) && value >= 0));
  return { latencyMs, maxMs: complete ? Math.max(...values) : null,
    invariants: { orderLatencyObserved: complete, orderP99UnderTwoSeconds: complete && latencyMs.p99 < 2000,
      allOrdersWithinTenSeconds: complete && values.every(value => value <= 10000) } };
}
