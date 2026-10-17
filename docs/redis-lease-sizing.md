# Redis purchase connection sizing

Historical sizing experiment: the subsequent framework-default policy removes
the HTTP guard and pool-size overrides. Its application pool default is supplied
by the Redis library, superseding the configuration recommendation below.

Measured the purchase connection lease separately from acquisition wait. Application
reply parsing and response construction now happen after returning the connection;
command construction happens before acquiring it. Wire-protocol decoding remains
inside the Redis client before its command promise resolves.

The lease starts when the built-in pool invokes its callback and ends during
callback cleanup, immediately before library return. It includes optional socket
reconnection, network time, Redis command execution and event-loop scheduling.
It is not Redis CPU time. Acquisition wait is measured separately from submission
to callback invocation. Successful acquisitions and expired acquisitions have
separate histograms; pool active/peak gauges and expiry counters complement the
HTTP guard's busy counter. Purchase, lookup and recovery measurements are separate.

Counts, sums and maxima are measured directly. Percentiles below are cumulative
histogram upper bounds: 0.25-ms resolution through 20 ms, then wider tail buckets.
Instrumentation adds overhead and remains identical across the sizing runs.

All trials use 3 APIs / 1 worker, 100 stock, 10,000 unique purchase requests,
10,000 preconnected clients, a 900-ms schedule and a one-second write deadline.
Only the API pool size changes through STRESS_ADMISSION_CONCURRENCY. Worker pool
maximum remains 16, API HTTP guard remains 64 per process, and library-default
acquisition timeout and separate operation deadline remain unchanged. Application
pool defaults have not been changed by the experiment.

## Verification

Passed 76 unit tests, 56 integration tests, 22 crash/network tests, typecheck,
lint, build and 21 harness tests. Integration coverage pauses post-reply processing and proves
that another buyer can use the only connection before that processing resumes.
Tests also retain late-command cancellation, safe acquisition expiry/retry and
crash-boundary uncertainty coverage. Review checked scope of the lease, bounded
metric cardinality/storage, histogram counting, deadline separation and the
absence of an acquireTimeout override.

## Excluded attempts

The first 16-connection attempt had missing dispatch evidence: 5,734 client
ECONNRESET errors and 3,732 unavailable preallocated sockets. Only 534 responses
completed. All stock eventually committed, but the committed-order observer was
unhealthy, observed p99 exceeded the order target and final proxy metrics failed.
It is not a valid one-second sizing comparison.

The next 16-connection attempt failed during socket setup with EADDRNOTAVAIL and
never produced final order accounting. A cooldown was allowed before repeating.
These failed attempts are retained in the evidence; no causal attribution to the
Redis pool size is made from them.

[First invalid attempt](evidence/redis-lease-sizing/pool-16-invalid-summary.json),
[socket setup failure](evidence/redis-lease-sizing/pool-16-socket-exhaustion-summary.json),
and [raw evidence/source manifest](evidence/redis-lease-sizing/manifest.json).


## Valid sizing runs

| Connections per API | Mean purchase lease | Lease p95 upper bucket | Observed lease max | Mean acquisition wait | Purchase HTTP busy | Order p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 3.88 ms | 12.00 ms | 72.06 ms | 21.04 ms | 3,603 | 765.15 ms |
| 16 | 5.04 ms | 13.75 ms | 49.50 ms | 9.30 ms | 1,051 | 521.43 ms |
| 32 | 7.80 ms | 50.00 ms | 65.45 ms | 2.09 ms | 67 | 529.27 ms |

Every valid run committed all 100 admissions, passed all correctness and order
latency gates, and returned zero purchase 504s. No Redis acquisition expired;
all purchase busy responses came from the HTTP guard. Every API reached its
configured lease maximum and all leases were released by final sampling.
Purchase lease sample counts were 6,397 / 8,949 / 9,933 for pools 8 / 16 / 32.
The lease p99 upper bucket was 50 ms in all three runs; this tail resolution is
too coarse to distinguish their p99s. Acquisition maxima were 88.78 / 60.41 /
58.73 ms. Last dispatch writes were 900.39 / 900.49 / 901.29 ms.

The 8-pool run had three HTTP 500 polling serialization errors; its all-route HTTP
busy counter was 3,606, three above the 3,603 purchase busy responses. The valid
16-pool rerun had no polling errors. The 32-pool run had 19 polling transport
errors. These poll-path problems remain unresolved. Independent order observation
and final metrics succeeded in the valid runs. Passing order gates does not
establish error-free HTTP/status service.

## Recommendation

For this 3/1 workload, **32 connections per API is a reasonable provisional choice**:
96 maximum API admission connections across three instances. Compared with 16,
mean acquisition wait fell from 9.30 to 2.09 ms and purchase HTTP busy fell from
1,051 to 67, with order p99 nearly unchanged (521 vs 529 ms). It did not eliminate
HTTP rejections or polling errors. Worker sizing is separate; its maximum was
unchanged. The application default stays 16 pending a configuration decision.

A starting estimate is `concurrency ≈ arrival rate × mean lease seconds`. At
10,000 requests/second divided across three APIs and the 16-pool mean, that is
16.8 connections per API before headroom (18.7 using the actual 900-ms schedule).
Sixteen therefore provides little average headroom. However, lease duration is
load-dependent: at 32 it increased to 7.80 ms while acquisition wait fell. More
concurrent commands can spend longer awaiting shared Redis, network and event-loop
work. These timings do not isolate the cause. Do not treat 5.04 ms as a fixed
service time or multiply by p99 to claim a precise capacity requirement.

These are single instrumented runs on a shared local Docker host. Trial order was
8, invalid 16, 32, setup-failed 16, then valid 16 after cooldown. They provide
sizing evidence, not a controlled proof of causality or production capacity.
Repeat on deployment-sized resources and the intended traffic mix before making
production guarantees. More API instances multiply the total connection budget.
No claim is made that moving parsing alone caused the observed changes.

[8-connection summary](evidence/redis-lease-sizing/pool-8-summary.json),
[16-connection summary](evidence/redis-lease-sizing/pool-16-summary.json),
[32-connection summary](evidence/redis-lease-sizing/pool-32-summary.json).
The [manifest](evidence/redis-lease-sizing/manifest.json) retains raw logs, resolved
Compose configurations, source snapshot, verification and analysis script. Source
identity, evidence hashes and response/lease accounting were verified. Isolated
services were cleaned up. No commit was made.
