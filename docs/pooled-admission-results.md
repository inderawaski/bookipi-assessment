# Reusable Redis admission connections

> These results precede the [10-ms FIFO acquisition wait](waitable-admission-pool.md). The benchmarks retain their original immediate pool-capacity rejection policy.

The earlier immediate-acknowledgement implementation opened and destroyed a Redis
socket for every operation, then awaited CONFIG GET and INFO persistence before
Lua. Exclusive socket ownership is useful for isolating uncertain outcomes and
timeouts, but neither fresh sockets nor repeated policy checks are necessary for
every purchase. The prior durability-offset design does not justify retaining
that overhead in the immediate-acknowledgement path.

## Implemented behavior

RedisAdmission now owns a bounded pool of exclusively leased connections. APIs
warm the configured pool before listening; workers warm one socket and can grow
up to the configured bound. Warm purchases and reservation lookups execute only
their Lua command. Successful operations return the socket to the pool. Errors
and deadlines discard the leased socket, and later operations can replace it.
A timed-out connection that finishes connecting late cannot send its purchase.
Shutdown closes idle and in-flight sockets.

The existing concurrency bound (16), three-second operation deadline, no waiting
queue, disabled offline buffering and no automatic command replay remain. A
timeout is still uncertain, and same-key replay is still required. Each lease is
exclusive so discarding one connection does not cancel another connection's
operation. PostgreSQL final stock-cap and Redis Lua admission scripts are unchanged.

CONFIG GET and INFO persistence checks run on the separate control connection at
startup and periodic readiness. Required AOF everysec/noeviction policy and AOF
write health remain checked there. Detection of runtime policy/write-health
changes is periodic, not synchronous on every purchase; already-running purchases
do not wait for readiness. Lua continues checking primary run ID, recovery epoch,
fault latch, configuration, TTL/type/accounting, duplicates, sale window and stock
on every purchase. Operators must preserve the required Redis policy during traffic.

## Verification

The reuse regression failed against the prior implementation and passes with the
pool. Unit coverage verifies no per-operation configuration/persistence checks,
reuse, bounded warmup, capacity, deadline replacement, isolation from another
healthy socket, late connection completion and shutdown. A real Redis test checks
CLIENT LIST identities stay exactly the same across repeated requests using two
warm sockets, and confirms shutdown removes those clients. Integration/failure
fixtures now close their persistent admission connections explicitly.

Passed: **75 unit tests, 52 integration tests, 22 crash/network tests**, typecheck,
lint and build. Existing restart, lost Redis reply, partition, lost COMMIT reply,
duplicate, sale-window and PostgreSQL final-cap tests retain their coverage.

## Spike follow-up

The follow-up uses the same 100 stock, 10,000 unique buyers, 10,000 preconnected
sockets, 900-ms scheduled arrivals and 1,000-ms dispatch deadline. Per-service
budgets remain one CPU / 512 MiB, with one worker. Runs start fresh isolated
services and volumes, execute sequentially after correctness suites finish and
allow socket recovery between configurations. They are single shared-host runs,
not statistical evidence of a stable capacity threshold.

| Configuration | Previous API mean ms | Pooled API mean ms | Previous order p99 ms | Pooled order p99 ms | Previous / pooled purchase 504 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1/1 | 22.44 | 2.38 | 800.32 | 833.57 | 6,346 / 3,082 |
| 6/1 | 26.72 | 6.98 | 3,230.02 | 1,067.70 | 0 / 0 |

Previous rows are the valid one-second cases in the [recorded matrix](api-window-matrix.md).
API mean is accumulated Fastify completed-response elapsed time divided by
completed HTTP request count, weighted across replicas. It includes all routes
and I/O waits; it is not CPU time or an admitted-purchase-only metric. Response
mixes and shared-host conditions differ, so the comparison is not a controlled
statistical estimate of overhead.

Both new runs dispatched validly (last writes 901.38 / 902.23 ms), committed all
100 admissions exactly once, conserved stock, drained pending entries and passed
all recorded correctness/order latency gates. Final direct/proxy metrics succeeded
and there were no recorded polling errors. Maximum observed order latency was
834.57 / 1,067.70 ms. The 1/1 run still returned 3,082 purchase 504s; passing the
stock/order gates does not imply satisfactory service for every caller. The 6/1
run returned structured responses to all 10,000 purchases: 100 queued, 6,478 busy
and 3,422 sold out, with no purchase gateway errors. Its client response mean was
325.02 ms and response p99 1,165.76 ms.

The structural overhead removal is verified by tests and the observed API means
fell in both configurations. The new 6/1 run also met the order SLO that the
preceding valid 6/1 run missed. This is consistent with the removed connection/
command overhead contributing to contention, but does not prove it was the sole
cause of earlier scaling variability. No new 10/1 run or two-second run is claimed
for this pooled revision.

## Evidence and review

[1/1 summary](evidence/pooled-admission/1api-summary.json),
[6/1 summary](evidence/pooled-admission/6api-summary.json) and
[manifest](evidence/pooled-admission/manifest.json) preserve raw requests,
visibility/metrics observations, source/host/configuration metadata, resource and
service logs, runner output, the expected pre-change regression failure, final
verification logs and the complete measured source bundle. This is an uncommitted
change on base 1a2dd66; the bundle identifies the actual measured implementation.

Review checked lease exclusivity, bounded capacity/warmup, late connection/reply
handling, timeout/error replacement, no command replay, shutdown ordering,
control-plane policy checks and unchanged Lua/final-stock-cap behavior. No change
to HTTP limits, proxy policy, workload, persistence acknowledgement contract or
order SLO was made to obtain these results.
