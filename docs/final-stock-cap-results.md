# Final PostgreSQL stock cap

> These spike measurements precede the Redis-only purchase-route change. See [the follow-up](redis-only-admission-results.md) for that implementation and its separate evidence.

The user approved the guard on 16 October 2026 after an isolated regression
reproduced two committed orders for one unit when an old transaction crossed
Redis reservation loss and recovery. [The decision and original failure](admission-loss-crash-race.md)
remain documented; the primary acknowledgement contract is unchanged.

## Behavior

Each order transaction begins explicitly at READ COMMITTED and acquires a
`FOR UPDATE` lock on its existing flash_sale row. Under that lock, a matching
existing order is returned idempotently, even when all stock is already committed.
For a new order, the transaction counts committed orders and refuses to insert
when the count reaches initial_stock. The lock is held through COMMIT or ROLLBACK.
All application final order writers use this path. No schema/table was added.

The guard adds no operation to Redis acknowledgement. PROCESSING still means
primary-memory acceptance, with no WAITAOF/WAIT or synchronous replica requirement.
PostgreSQL finalization is serialized per sale, so throughput/latency must be
measured with this guard rather than inferred from the earlier 365-ms result.

A replacement reservation that conflicts with committed capacity stays pending
and is quarantined. The worker sets admission_fault=committed_order_capacity,
fencing new admissions for operator reconciliation. It neither commits an extra
order nor releases Redis stock. Committed orders remain readable as SUCCESS.
Loss of acknowledged Redis reservations is still an accepted risk; the guard
protects final order count, not guaranteed fulfillment of every provisional request.

The [decision record](decisions.md#final-stock-cap-trade-off-user-approved-16-october-2026)
spells out the throughput, lock-wait, count-query and reconciliation-availability
trade-offs. The initial final-guard spike below is **1 API / 1 worker**; the
requested 3/1 follow-up is recorded separately below. The older WAITAOF scale-out
matrix cannot substitute for these measurements.

## Regression coverage

The permanent `tests/integration/admission-loss.test.ts` regression pauses an old
order just before commit, restores an older consistent Redis snapshot, reconciles
against no visible committed orders and admits another buyer. It starts the new
worker before releasing the old transaction. The guard leaves one committed order,
permits its matching replay at full capacity, quarantines the replacement and
keeps admission fenced. The fault latch remains closed on attempted reconciliation.

Unit cases cover full-capacity replay, conflicting identity, unknown commit reply,
zero/full capacity and insertion below capacity. Verification passed 65 unit tests, 48 integration tests, 22 crash/network tests,
typecheck, lint and build. The focused loss/race pair passed with a JSON report.
Temporarily removing FOR UPDATE reproduced the oversell in the real regression;
restoring the lock made it pass. The earlier expected failure is retained separately.

Crash testing exposed an old fault-injector substring match: COMMIT matched inside
READ COMMITTED and dropped BEGIN's reply. It now matches the exact PostgreSQL
COMMIT wire frame, with a bounded tail for fragmented packets. The full 22-test
crash/network suite passed after that correction, including lost COMMIT reply.
UI and harness checks were already verified in the preceding acknowledgement
revision (23 browser and 20 harness tests); they were not rerun for this DB guard.

## Healthy spike with the final guard

Measured on 16 October 2026 (Asia/Jakarta), using the same local host and budget as
the immediate-acknowledgement run: one API, one worker, one Redis primary, one
asynchronous Redis replica, PostgreSQL and stress proxy, each one CPU / 512 MiB.
The generator uses 10,000 preconnected sockets, 10,000 unique buyers and 100 stock.
No automatic buyer retry is performed. This is one shared-host run, not statistical
capacity evidence.

| Measurement | Result |
| --- | ---: |
| Last request write | 904.45 ms — valid |
| Admissions / committed orders | 100 / 100 |
| Admission-to-committed-order visibility p50 | 396.29 ms |
| p95 | 517.50 ms |
| p99 / maximum | 544.11 ms |
| Busy | 2,135 |
| Sold out | 3,025 |
| HTTP 504 | 4,740 |

All stock/order/reconciliation invariants passed, along with the unchanged spike
gates of p99 < 2,000 ms and every admitted order <= 10,000 ms. The approximately
25-ms committed-visibility sampling delay is included. The pre-guard immediate
acknowledgement result had about 365-ms p99; this final guarded run had about
544-ms p99. Two single runs do not isolate guard overhead from host variability.

**HTTP overload remains:** 4,740 proxy 504s (3484 connection / 1256 response-read
timeouts). No HTTP error-rate SLO has been declared, so the passing stock/order
gates must not be presented as successful service for all 10,000 requests. This
change does not address that separate ingress/API overload problem.

## Requested 3 API / 1 worker follow-up

The user requested 3/1 only; no new 1/3 or 3/3 runs were performed. Two fresh
isolated 3/1 attempts used the same final implementation, 100 stock, 10,000 unique
buyers, 10,000 preconnected sockets and one-second dispatch window. Worker,
PostgreSQL, Redis primary/replica and proxy budgets stayed fixed. Each API retained
one CPU / 512 MiB, so adding two APIs increased total application resources.

```sh
STRESS_API_REPLICAS=3 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k
```

| Configuration / attempt | Last write ms | Orders | Order p99 ms | Order max ms | Busy | Sold out | HTTP 504 | Overall run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1/1 baseline | 904.45 | 100 | 544.11 | 544.11 | 2,135 | 3,025 | 4,740 | passed declared gates |
| [3/1 attempt 1](evidence/final-stock-cap/flash-test-841c2f1b-29ba-4201-904d-1285b18dcfef/spike-10k/result.json.gz) | 903.42 | 100 | 1,878.05 | 1,901.65 | 5,055 | 4,172 | 673 | measurement_failed |
| [3/1 attempt 2](evidence/final-stock-cap/flash-test-9f59f13c-72ab-473c-8b2e-47b073602c5d/spike-10k/result.json.gz) | 901.30 | 100 | 1,067.18 | 1,086.33 | 4,523 | 4,544 | 833 | measurement_failed |

**Both 3/1 attempts had valid dispatch, filled stock and passed every recorded
order/correctness invariant**, including p99 < 2,000 ms and maximum <= 10,000 ms.
All 100 buyers were admitted within the first second (last admission at 560 ms
and 299 ms respectively relative to the Redis dispatch-time anchor). Every
acknowledged admission became exactly one committed order. API metric deltas show
all three API replicas participated: admissions were 44/48/8 and 16/32/52.

**Neither 3/1 attempt is a complete passing run.** After reconciliation, the
harness obtained direct metrics from all three APIs but the final proxy-routed
GET /metrics failed. Nginx logged `no live upstreams while connecting to upstream`
for that request. The harness recorded Metrics unavailable, retained
runStatus=measurement_failed and exited nonzero. The second run repeated the same
failure; no timeout, acceptance check, proxy policy or harness code was changed to
turn it into a pass. Post-load proxy availability is a real unresolved finding,
not evidence that the three API processes themselves were dead.

The 673 and 833 purchase 504s were all connection timeouts. Scaling APIs reduced
purchase gateway errors compared with the 4,740-error baseline, while more buyers
received explicit busy/sold-out responses. It did not eliminate ingress failure,
and measured order p99 was higher than baseline, though still under target. These
few shared-host runs do not establish a stable scaling ratio or isolate the cause
of increased order latency; per-stage database/CPU contention measurements would
be needed for that attribution.

[Both attempt summaries](evidence/final-stock-cap/3api-summary.json), raw request
records, service/resource logs, resolved configurations and runner logs are
retained in the existing manifest. Original 1/1 evidence is unchanged.

## Requested 4 API / 1 worker follow-up

One fresh isolated 4/1 run used the same implementation, workload and per-service
budgets as 3/1, with one additional API. No proxy policy, timeout or acceptance gate
was changed. The run started at 2026-10-16 16:33:49 UTC (23:33:49 Asia/Jakarta).

```sh
STRESS_API_REPLICAS=4 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k
```

| Measurement | 4/1 result |
| --- | ---: |
| Last request write | 902.37 ms — valid |
| Admissions / committed orders | 100 / 100 |
| Admission-to-committed-order visibility p50 | 1,097.12 ms |
| p95 | 1,756.94 ms |
| p99 | 1,782.13 ms |
| Maximum | 1,783.13 ms |
| Busy / sold out | 5,544 / 3,976 |
| Purchase HTTP 504 | 380 |
| Overall run | measurement_failed |

All recorded stock/order invariants passed, including p99 < 2,000 ms and maximum
<= 10,000 ms. All 100 admissions occurred within the first second; the last was
at 987 ms relative to the Redis dispatch-time anchor. The four API admission
counts were 32/23/23/22. No acknowledged admission was lost, stock reached zero,
and the queue had no pending entries at final reconciliation.

The 380 purchase 504s were all upstream connection timeouts. This is fewer than
the 673/833 errors in the two 3/1 attempts (about 44%/54% fewer), but order p99
fell between those two runs. One shared-host measurement does not establish that
4/1 consistently improves latency or isolates Redis as the bottleneck.

The complete test still exited nonzero: all four direct API metrics snapshots
succeeded, then the final proxy-routed GET /metrics failed with Nginx reporting
`no live upstreams while connecting to upstream`, repeating the 3/1 availability
finding. A status poll also returned HTTP 500 with
`FST_ERR_FAILED_ERROR_SERIALIZATION`; subsequent polls returned SUCCESS before
later proxy errors. This polling error is retained in the evidence and is a
separate unresolved finding. Passing order gates do not make this a fully passing
spike test.

The [4/1 summary](evidence/final-stock-cap/4api-summary.json) and
[raw result](evidence/final-stock-cap/flash-test-2a17d377-6b5a-4201-97c0-92da73287bb9/spike-10k/result.json.gz)
are archived with service logs, resource samples, configuration, host/source
metadata and runner output. All 44 compressed manifest entries were verified
against their original size and SHA-256. No runtime sources were changed for this
experiment.

## Requested 5 API / 1 worker follow-up

One fresh isolated 5/1 run used the same implementation, workload and per-service
budgets as 4/1, with one additional API. It started at 2026-10-16 16:37:22 UTC
(23:37:22 Asia/Jakarta). No runtime source, proxy policy or acceptance gate changed.

```sh
STRESS_API_REPLICAS=5 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k
```

| Measurement | 4/1 | 5/1 |
| --- | ---: | ---: |
| Last request write | 902.37 ms | 902.38 ms |
| Admissions / committed orders | 100 / 100 | 100 / 100 |
| Admission-to-committed-order visibility p50 | 1,097.12 ms | 1,986.89 ms |
| p95 | 1,756.94 ms | 3,005.41 ms |
| p99 | 1,782.13 ms | 3,014.88 ms |
| Maximum | 1,783.13 ms | 3,014.88 ms |
| Busy | 5,544 | 7,982 |
| Sold out | 3,976 | 1,876 |
| Purchase HTTP 504 | 380 | 42 |
| Overall | measurement_failed | failed order p99 gate |

**5/1 failed the declared p99 < 2,000 ms gate.** Dispatch was valid and every
other recorded invariant passed: all 100 admissions occurred within the first
second (last at 340 ms), all became exactly one committed order, stock reached
zero without overselling, the queue drained and every order completed within
10 seconds. Direct API admission deltas were 16/16/18/32/18.

All 42 purchase 504s were upstream connection timeouts, about 89% fewer than 4/1.
Final metrics succeeded through the proxy and directly from all five APIs; this
run did not repeat the post-burst metrics availability failure. The harness
recorded runStatus=valid_dispatch and passed=false, then exited nonzero because
of the order latency assertion. This is a measured latency failure rather than
a measurement failure. One status poll returned HTTP 500 with
`FST_ERR_FAILED_ERROR_SERIALIZATION`; subsequent polls recovered to HTTP 200.
This repeats the separate polling error observed in 4/1 and remains unresolved.

More API capacity reduced gateway timeouts in this run, but durable-order latency
increased beyond the target. Worker, PostgreSQL, Redis and proxy budgets stayed
fixed while total API resources increased. These single shared-host runs cannot
identify which downstream resource caused the increase or establish a stable
scaling trend; the evidence does not isolate Redis as the bottleneck.

The [5/1 summary](evidence/final-stock-cap/5api-summary.json) and
[raw result](evidence/final-stock-cap/flash-test-284ef3eb-45e8-4b39-bcb6-b36ac0c92265/spike-10k/result.json.gz)
retain request records, visibility observations, resolved configuration, source
and host metadata, service/resource logs and runner output. All 52 compressed
manifest entries were checked against their original size and SHA-256.

## Requested 6 API / 1 worker follow-up

One fresh isolated 6/1 run used the same implementation, workload and per-service
budgets as 5/1, with one additional API. It started at 2026-10-16 16:40:46 UTC
(23:40:46 Asia/Jakarta). Runtime sources, proxy policy and acceptance gates stayed
unchanged.

```sh
STRESS_API_REPLICAS=6 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k
```

| Measurement | 5/1 | 6/1 |
| --- | ---: | ---: |
| Last request write | 902.38 ms | 901.01 ms |
| Admissions / committed orders | 100 / 100 | 100 / 100 |
| Admission-to-committed-order visibility p50 | 1,986.89 ms | 2,803.74 ms |
| p95 | 3,005.41 ms | 3,768.62 ms |
| p99 | 3,014.88 ms | 3,825.30 ms |
| Maximum | 3,014.88 ms | 3,848.79 ms |
| Busy | 7,982 | 8,576 |
| Sold out | 1,876 | 1,324 |
| Purchase HTTP 504 | 42 | 0 |
| Overall | failed order p99 gate | failed order p99 gate |

**6/1 failed the declared p99 < 2,000 ms gate.** Dispatch was valid and every
other recorded invariant passed. All 100 admissions occurred within the first
second (last at 252 ms), all became exactly one committed order, stock reached
zero without overselling, pending entries drained and every order completed
within 10 seconds. Direct API admission deltas were 1/17/16/17/32/17.

Every purchase received a structured API response: 100 queued, 8,576 busy and
1,324 sold out. There were no purchase gateway errors. Final metrics succeeded
through the proxy and directly from all six APIs. The harness retained
runStatus=valid_dispatch and passed=false, exiting nonzero for the order latency
gate rather than a measurement failure. One status poll returned HTTP 500 with
`FST_ERR_FAILED_ERROR_SERIALIZATION`, followed by successful HTTP 200 polls;
the separate polling issue observed in 4/1 and 5/1 remains unresolved.

Compared with 5/1, admission finished earlier and purchase gateway errors fell to
zero, while durable-order visibility p99 increased by about 810 ms. The worker,
PostgreSQL, Redis and proxy budgets stayed fixed as total API resources grew.
This shared-host result does not isolate the cause of slower final processing;
it does not establish Redis as the bottleneck or a stable capacity limit.

The [6/1 summary](evidence/final-stock-cap/6api-summary.json) and
[raw result](evidence/final-stock-cap/flash-test-6c1857af-8dfa-416b-ae56-ac209c3de75b/spike-10k/result.json.gz)
retain request records, visibility observations, configuration, source/host
metadata, service/resource logs and runner output. All 60 compressed manifest
entries were checked against original size and SHA-256.

## Requested return to 3 API / 1 worker

After the 4/1, 5/1 and 6/1 experiments, the user requested a fresh 3/1 retest.
This run started at 2026-10-16 16:42:40 UTC (23:42:40 Asia/Jakarta), using fresh
isolated services and volumes, the same implementation and unchanged settings:
100 stock, 10,000 unique buyers, 10,000 preconnected sockets and a one-second
request dispatch window. No runtime source, proxy policy or acceptance gate changed.

```sh
STRESS_API_REPLICAS=3 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k
```

| Measurement | Earlier 3/1 attempt 1 | Earlier 3/1 attempt 2 | 3/1 retest |
| --- | ---: | ---: | ---: |
| Last request write | 903.42 ms | 901.30 ms | 901.12 ms |
| Admissions / committed orders | 100 / 100 | 100 / 100 | 100 / 100 |
| Admission-to-committed-order visibility p99 | 1,878.05 ms | 1,067.18 ms | 717.16 ms |
| Maximum | 1,901.65 ms | 1,086.33 ms | 735.93 ms |
| Purchase HTTP 504 | 673 | 833 | 190 |
| Overall | measurement_failed | measurement_failed | measurement_failed |

The retest had p50 420.64 ms and p95 714.16 ms. Every recorded stock/order invariant
passed, including p99 < 2,000 ms and every admitted order <= 10,000 ms. All 100
admissions occurred within the first second, the last at 136 ms relative to the
Redis dispatch-time anchor. Direct API admission deltas were 36/31/33. All admitted
orders committed exactly once, stock reached zero and pending entries drained.
Purchase responses were 100 queued, 5,322 busy, 4,388 sold out and 190 HTTP 504s;
all gateway timeouts occurred while connecting upstream.

**The complete retest still failed at measurement collection.** Direct metrics
from all three APIs succeeded, then the final proxy-routed GET /metrics failed
with Nginx reporting `no live upstreams while connecting to upstream`. The harness
recorded Metrics unavailable, runStatus=measurement_failed and passed=false,
exiting nonzero. This repeats both earlier 3/1 attempts; passing order gates do
not resolve the post-burst proxy availability issue.

Returning to 3/1 produced substantially lower durable-order latency than the
preceding 5/1 and 6/1 runs, and fewer gateway errors than either earlier 3/1 run.
The differing results at the same replica count show material run variability.
Fresh test services prevent reuse of prior sale/queue state, but the shared host
and Docker VM remain common resources. These observations do not isolate Redis,
the worker, PostgreSQL or host scheduling as the cause of the latency differences.

The [3/1 retest summary](evidence/final-stock-cap/3api-recheck-summary.json) and
[raw result](evidence/final-stock-cap/flash-test-7bc65656-597c-4f08-be9f-ce2736e65deb/spike-10k/result.json.gz)
are retained separately from earlier attempts, with configuration, host/source
metadata, service/resource logs and runner output. All 68 compressed manifest
entries were checked against original size and SHA-256.

## Evidence

The [summary](evidence/final-stock-cap/summary.json),
[raw result](evidence/final-stock-cap/flash-test-f3a1530a-910b-4436-910b-9c6cf0a5e159/spike-10k/result.json.gz),
[focused regression JSON](evidence/final-stock-cap/race-results.json.gz) and
[manifest](evidence/final-stock-cap/manifest.json) retain final verification logs,
the expected mutation failure, restored regression, full failure JSON, source
bundle, resolved Compose, host metadata, request records, visibility observations,
service logs and resource samples. Each manifest entry records original size and
SHA-256. The working tree was uncommitted; the archived source bundle identifies
the final implementation rather than relying only on its base commit.
