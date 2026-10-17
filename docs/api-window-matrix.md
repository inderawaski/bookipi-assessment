# API count and arrival-window matrix

> Historical measurements before connection pooling and removal of per-operation Redis health checks. See [the pooled follow-up](pooled-admission-results.md).

Requested 17 October 2026, application revision `1a2dd66`. Four fresh isolated
runs compare one versus six APIs, always one worker, and 10,000 unique requests
within one versus two seconds. Each sale has 100 units. The same 10,000
preconnected sockets, PostgreSQL, Redis primary/asynchronous replica, Nginx,
per-service one CPU / 512 MiB budgets, application concurrency limits and order
gates are retained. Total resources increase with API count; this is not a fixed
total-CPU experiment. The harness schedules requests over 900 or 1,800 ms and
requires all writes before 1,000 or 2,000 ms, respectively.

Runs execute sequentially, each in its own random Compose project with fresh
volumes. A 45-second recovery gap before setup separates subsequent cases; setup
and the pre-sale lead-in add further separation before the next dispatch. The
host and Docker VM remain shared, so this single four-run matrix does not establish
stable capacity or isolate the cause of worker slowdown.

## Where each response comes from

**Busy is returned by the API, HTTP 429.** Two independent local guards can
produce the same JSON `REJECTED/busy`:

1. The HTTP guard in packages/operations rejects when that API already holds
   64 request slots. This can reject before a route or Redis is reached.
2. RedisAdmission, running inside the API process, rejects when its 16 Redis
   operation slots are occupied. These slots cover connection, Redis safety/
   persistence checks and Lua execution through cleanup. This is not a Redis
   server business rejection and neither limit is a requests-per-second rate.

Busy is a definite pre-admission rejection, allocates no stock and is not bound
to an idempotency outcome. The caller may retry. Six APIs provide more aggregate
local slots, subject to distribution and shared dependency capacity. The HTTP
limit includes other routes; Redis operation slots also serve admission lookups.

**Sold out is decided atomically by Redis Lua and returned by the API, HTTP 409.**
For a fresh eligible request, after replay/duplicate handling and the sale-window
check, `remaining_stock == 0` returns `REJECTED/sold_out`. Stock is consumed at
reservation, so all units can be sold out while orders are still processing. This
does not mean PostgreSQL has already committed every order. The rejection outcome
is remembered for the request key and replays consistently. Busy can occur even
when stock is zero because local guards run before Lua can inspect inventory.

**504 is returned by Nginx, not the application or worker.** The stress proxy has
`proxy_connect_timeout 2s`, `proxy_read_timeout 5s` and `proxy_next_upstream off`.
It can time out establishing an API connection or waiting for upstream response
data. Service logs distinguish `while connecting to upstream` from `while reading
response header from upstream`. The harness records these non-JSON gateway
responses as invalid_response; they are not sold-out or busy business outcomes.

A response-read timeout can occur after Redis admitted a request, so 504 alone
cannot establish whether an order was reserved. Same-key retry/lookup is needed.
The purchase response does not wait for PostgreSQL durability; slow worker
processing alone does not directly trigger a purchase 504. Shared CPU/network/
Redis contention can slow the API while also slowing the worker. Final proxy
metrics availability is separately reported and is not hidden as an order pass.

## Four valid cases

All four rows below dispatched validly, admitted and committed 100 orders,
conserved stock, avoided duplicate orders, preserved all acknowledged admissions
and drained pending entries. Final direct/proxy metrics succeeded.

| API/worker | Dispatch window | Last write ms | Order p99 ms | Order max ms | Busy | Sold out | HTTP 504 | Declared order gates |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1/1 | 1s | 901.85 | 800.32 | 815.51 | 398 | 3,156 | 6,346 | passed |
| 1/1 | 2s | 1,801.74 | 591.95 | 621.63 | 3,002 | 1,770 | 5,128 | passed |
| 6/1 | 1s | 903.38 | 3,230.02 | 3,255.55 | 8,547 | 1,353 | 0 | failed p99 < 2s |
| 6/1 | 2s | 1,802.29 | 3,839.30 | 3,847.30 | 7,857 | 2,032 | 11 | failed p99 < 2s |

Order p99 measures Redis admission to first observed committed PostgreSQL
visibility, including the existing sampling/query delay. It is distinct from HTTP
response latency. There is no declared HTTP error-rate SLO: the passing 1/1 order
gates do not mean acceptable service to every caller when over half receive 504.
Both 6/1 runs failed only the final orderP99UnderTwoSeconds invariant; every order
still completed within 10 seconds. No main-table purchase response was HTTP 502.
All main-table status totals include 100 queued HTTP 202s and sum to 10,000.

Increasing APIs reduced purchase gateway errors sharply in both arrival windows,
but observed order p99 worsened: 800 to 3,230 ms for one second, and 592 to 3,839 ms
for two seconds. More callers received explicit busy responses. Stretching the
arrival window helped 1/1 in this pair (lower order p99 and fewer 504s), but did
not help 6/1 durability (3,230 to 3,839 ms) and introduced 11 purchase 504s. These
single shared-host observations do not establish a causal scaling law or identify
Redis, PostgreSQL, the worker or host scheduling as the root cause.

### Proxy evidence

| Case | 504 while connecting | 504 while reading response |
| --- | ---: | ---: |
| 1/1, 1s | 2,068 | 4,278 |
| 1/1, 2s | 4,622 | 506 |
| 6/1, 1s valid repeat | 0 | 0 |
| 6/1, 2s | 11 | 0 |

The valid cases had no recorded order-poll errors. The 64 HTTP / 16 Redis-operation
limits per API and proxy connection/read timeouts stayed unchanged throughout.

### Preserved invalid attempt

The first 6/1 one-second attempt wrote its last request at 1,261.27 ms, yielding
validDispatch=false with dispatch_outside_window. It is excluded from the main
comparison and was repeated under identical settings with a fresh project after
the 6/1 two-second run. The valid repeat wrote its last request at 903.38 ms.

The invalid attempt still committed 100 orders (recorded order p99 3,404.76 ms),
but returned 1,342 purchase 504s and 1,678 purchase 502s. Logs contain 1,342
purchase upstream connection timeouts and 1,678 purchase no-live-upstreams errors.
It also failed final proxy metrics with no live upstreams, despite all six direct
API snapshots succeeding, and retained runStatus=measurement_failed. Both the
invalid dispatch and measurement failure are preserved rather than reclassified
as a valid one-second result. No timeout, workload, limit or proxy policy was
changed for its repeat.

## Evidence

- [1api-1s summary](evidence/api-window-matrix/1api-1s-summary.json)
- [1api-2s summary](evidence/api-window-matrix/1api-2s-summary.json)
- [6api-1s summary](evidence/api-window-matrix/6api-1s-summary.json)
- [6api-2s summary](evidence/api-window-matrix/6api-2s-summary.json)
- [Invalid 6/1 one-second attempt](evidence/api-window-matrix/6api-1s-attempt1-summary.json)
- [Compressed evidence manifest](evidence/api-window-matrix/manifest.json)

The manifest retains all five attempts' raw records, visibility observations,
resolved configuration, source/host metadata, service/resource logs and runner
output, plus the full implementation source bundle. The application source was
verified identical to commit 1a2dd66 for every tracked apps/packages file. The
optional two-second harness addition is the same verified addition used in the
preceding comparison; no runtime source changes were made for this matrix.
Original record counts, unique buyer counts, dispatch deadlines, response totals,
order invariants and compressed sizes/SHA-256 are checked independently. No new
commit or deployment is made for this benchmark task.
