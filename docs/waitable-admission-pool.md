# Waitable Redis admission pool

Current policy: use Fastify without an application HTTP guard and the Redis
client built-in pool without size or acquisition timeout overrides. The installed redis@6.3.0 defaults to 3,000 ms. The 10-ms implementation
and spike measurements below are historical and do not measure the current policy.
See [the superseding decision](decisions.md#built-in-redis-pool-with-default-acquisition-timeout-user-approved-17-october-2026).

Business requirement approved on 17 October 2026: when all Redis admission
connections are leased, allow a purchase to wait FIFO for up to **10 ms** instead
of rejecting it immediately. The configured pool remains 16 connections per API
and the HTTP guard remains 64 active requests per API.

```text
HTTP guard rejects if its 64 slots are already occupied
validate input
queue for a Redis lease (FIFO within this API)
    grant immediately if capacity is available
    otherwise wait up to 10 ms
    expiry: return 429 REJECTED/busy without executing Lua
once granted:
    begin the separate 3-second Redis operation deadline
    execute admission Lua
    return healthy socket to the oldest eligible waiter, or to the idle pool
```

Waiting requests retain their HTTP slots. New arrivals cannot bypass live queued
waiters to acquire a Redis lease. An expired waiter is removed, its timer cleared,
and it cannot reserve stock, bind an idempotency key or execute later. A monotonic
deadline is also checked on handoff so delayed timer callbacks do not grant stale
waiters. Failed sockets permit replacement capacity to go to the oldest eligible
waiter. Shutdown cancels queued acquisitions and clears their timers.

The 10-ms deadline covers waiting for a lease. If a failed socket needs replacing,
connection establishment is covered by the existing operation deadline after
acquisition. The queue does not replay commands. Existing uncertainty handling,
Redis fences, stock/duplicate/window rules and PostgreSQL final stock cap remain.

FIFO acquisition is local to an API instance, not a global browser-arrival-order
guarantee across APIs or strict Lua execution ordering across parallel sockets.
Redis execution order remains admission authority. Pool wait expiry and the
independent HTTP guard can still reject a request before later arrivals. This is
a bounded opportunity to wait, not a complete elimination of rejection-based
fairness limitations.

The budget is the approved policy, motivated by 2-ms average processing and four
waves of HTTP capacity. Actual lease-hold time, tail latency and event-loop/network
scheduling determine whether a waiter obtains a lease in time. Ten milliseconds
is not an end-to-end response deadline or a guaranteed four-wave drain time.

## Verification

Tests cover successful FIFO handoff, ten-millisecond expiry without later
execution, shutdown cancellation and an expired handoff with its timer deliberately
not fired. Real Redis coverage holds a lease, expires another purchase before Lua,
checks that its key/outcome/stock were not mutated and then retries that key safely.
The existing pooled reuse, late connection, operation deadline, restart, duplicate,
window, network uncertainty and stock-cap coverage also runs.

The preceding [pooling results](pooled-admission-results.md) used immediate
pool-capacity rejection. The following run measures the new acquisition policy.

Passed **79 unit tests, 53 integration tests, 22 crash/network tests**, typecheck,
lint and build. Review checked FIFO reservation of leases, expiry/handoff races,
shutdown cleanup, absence of late Lua execution and independence of the operation
deadline. [Verification logs and source manifest](evidence/waitable-admission-pool/manifest.json)
retain the tested revision. Changes are uncommitted.


## 1/1 spike follow-up

On 17 October 2026 at 10:08 Jakarta time, ran 1 API / 1 worker with 100 stock
and 10,000 unique purchase requests scheduled over 900 ms. The final request
was written at 903.04 ms, satisfying the one-second dispatch requirement.
All correctness and order-latency gates passed: 100 admissions became 100
committed orders, without overselling or duplicate orders.

| Measurement | Previous immediate pool rejection | FIFO wait up to 10 ms |
| --- | ---: | ---: |
| Committed orders | 100 | 100 |
| Admission-to-durability p99 | 833.57 ms | 1,568.45 ms |
| Admission-to-durability maximum | 834.57 ms | 1,568.45 ms |
| Mean API handling time | 2.38 ms | 6.67 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 6,428 | 5,483 |
| 429 busy | 390 | 386 |
| 504 gateway timeout | 3,082 | 4,031 |
| Mean client response time | 3,125.23 ms | 2,683.12 ms |

The new run passed p99 below two seconds and every order below ten seconds.
This does not establish acceptable HTTP availability for all buyers: 4,031
purchase requests received 504. Nginx logged 3,945 purchase timeouts while
connecting to the API and 86 while reading the upstream response. A separate
GET connection timeout also occurred; the harness recorded one polling error
because an HTML response could not be parsed as JSON. The committed-order
observer remained healthy and all order gates passed.

The API mean is elapsed handling time for 6,025 completed HTTP requests across
routes, including pool waiting; it is not purchase-only CPU time or client
latency and excludes requests that never reached the handler. Busy counts
combine the HTTP guard and Redis acquisition expiry, so these counts do not
isolate the pool queue's effect. This single shared-host before/after comparison
shows higher API handling time, order p99 and gateway timeout count, with little
change in busy responses. It does not isolate the cause of the order or gateway
latency changes. FIFO acquisition remains a bounded local waiting policy.

[Run summary](evidence/waitable-admission-pool/1api-summary.json),
[previous summary](evidence/pooled-admission/1api-summary.json) and
[archived raw evidence with source snapshot](evidence/waitable-admission-pool/manifest.json)
retain the measurements and implementation identity. The stress command exited
successfully; its isolated services were cleaned up. No commit was made.


## 2/1 spike follow-up

On 17 October 2026 at 10:12 Jakarta time, repeated the same 100-stock,
10,000-unique-request spike with 2 APIs / 1 worker. The final write was at
910.45 ms, within the one-second dispatch requirement.

| Measurement | 1 API / 1 worker | 2 APIs / 1 worker |
| --- | ---: | ---: |
| Committed orders / admissions | 100 / 100 | 100 / 100 |
| Admission-to-durability p99 | 1,568.45 ms | 1,196.55 ms |
| Admission-to-durability maximum | 1,568.45 ms | 1,231.22 ms |
| Mean API handling time | 6.67 ms | 17.20 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 5,483 | 4,554 |
| 429 busy | 386 | 2,824 |
| 504 gateway timeout | 4,031 | 2,522 |
| Mean client response time | 2,683.12 ms | 2,117.27 ms |

All recorded correctness and order-latency gates passed, including stock
conservation, duplicate protection, full sell-through, p99 below two seconds
and every order below ten seconds. However, the overall test **failed its
measurement step**: the final metrics collection through Nginx returned
“Metrics unavailable.” The command exited 1 with runStatus measurement_failed;
it must not be described as an overall passing test.

Direct before/after metrics from both APIs were captured before that failure:
3,728 completed HTTP requests at 16.73 ms mean handling on API 1, and 3,769 at
17.67 ms on API 2, giving the weighted 17.20-ms mean above. These are all-route
elapsed handling measurements, including pool waiting, with the same limitations
as the 1/1 measurement.

All 2,522 purchase 504s were Nginx timeouts connecting to an API. The service log
also contained 18 “no live upstreams” events; the harness recorded 17 polling
JSON parse errors from HTML responses. The separate committed-order observer
remained healthy. The final metrics failure occurred at case.mjs line 137,
after direct replica metrics collection and final order accounting.

This run had lower order p99, client mean response time and purchase 504 count
than 1/1, but higher API handling time and busy count. Busy responses combine
the HTTP guard and pool-acquisition expiry; no cause is isolated by this single
shared-host comparison. No source changes were made for this run.

[2/1 summary](evidence/waitable-admission-pool/2api-summary.json) and
[raw evidence manifest](evidence/waitable-admission-pool/manifest.json) preserve
the failed measurement and captured results. Isolated services were cleaned up.


## Built-in pool verification (current policy)

The custom acquisition queue has been replaced by createClientPool with no
acquireTimeout override. The installed redis@6.3.0 default is 3,000 ms.
Verified 75 unit tests, 55 integration tests and 22 crash/network tests, plus
typecheck, lint and build. Real Redis tests cover FIFO handoff after waiting
beyond the old 10-ms limit, acquisition expiry without key/stock mutation, safe
retry after expiry, and prevention of delayed sends after an operation timeout
and connection reuse. Unit coverage verifies the acquisition option is omitted,
pre-acquisition timeout mapping, operation uncertainty and shutdown cancellation.

Review checked deadline separation, default option use, pool warm/maximum sizes,
error classification, disabled automatic replay, aborted operation proxies and
shutdown behavior. [Verification logs and source snapshot](evidence/built-in-admission-pool/manifest.json)
retain this revision. No spike was rerun for this policy, and no commit was made.


## Built-in pool 1/1 spike

On 17 October 2026 at 10:36 Jakarta time, ran 1 API / 1 worker with 100 stock
and 10,000 unique requests scheduled over 900 ms. The last write occurred at
900.77 ms, satisfying the one-second dispatch requirement. The command exited 0,
runStatus was valid_dispatch, and all correctness and order-latency gates passed.

| Measurement | Custom pool, 10-ms wait, 1/1 | Built-in pool, default wait, 1/1 |
| --- | ---: | ---: |
| Committed orders / admissions | 100 / 100 | 100 / 100 |
| Admission-to-durability p99 | 1,568.45 ms | 388.54 ms |
| Admission-to-durability maximum | 1,568.45 ms | 413.46 ms |
| Mean API handling time | 6.67 ms | 6.07 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 5,483 | 6,388 |
| 429 busy | 386 | 2,548 |
| 504 gateway timeout | 4,031 | 964 |
| Mean client response time | 2,683.12 ms | 914.54 ms |
| Client response p99 | 5,543.69 ms | 2,729.15 ms |

All 964 purchase 504s were Nginx timeouts connecting to the API. API handling
mean covers 9,060 completed HTTP requests across routes, including pool wait;
it excludes requests that never reached the handler and is not purchase-only
CPU time. Busy responses combine the independent HTTP guard and pool acquisition
expiry; their split was not isolated. Higher busy count alongside fewer gateway
timeouts changes the response mix and does not establish complete buyer fairness.

One status poll returned HTTP 500 with FST_ERR_FAILED_ERROR_SERIALIZATION. This
polling/serialization issue remains unresolved; it did not fail the harness's
order gates. The independent committed-order observer and final metrics collection
succeeded. Passing order gates does not imply error-free HTTP service for buyers.

The run shows lower order p99 and client latency than the custom-pool 1/1 run.
Both pool implementation and acquisition policy changed, and these are single
shared-host measurements; their individual effects have not been isolated.
No application source changes or commit were made during this run. Isolated
services were cleaned up.

[Built-in pool run summary](evidence/built-in-admission-pool/1api-summary.json) and
[raw evidence/source manifest](evidence/built-in-admission-pool/manifest.json)
preserve the result. All evidence hashes and source identity were verified.


## Built-in pool 2/1 spike

On 17 October 2026 at 10:42 Jakarta time, repeated the same 100-stock,
10,000-unique-request, one-second spike with 2 APIs / 1 worker. The final write
was at 901.21 ms. The command exited 0 with valid_dispatch and all correctness
and order-latency gates passed. All 100 admissions became committed orders.

| Measurement | Built-in pool 1/1 | Built-in pool 2/1 |
| --- | ---: | ---: |
| Committed orders / admissions | 100 / 100 | 100 / 100 |
| Admission-to-durability p99 | 388.54 ms | 384.18 ms |
| Admission-to-durability maximum | 413.46 ms | 384.18 ms |
| Mean API handling time | 6.07 ms | 10.24 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 6,388 | 8,351 |
| 429 busy | 2,548 | 1,549 |
| 504 gateway timeout | 964 | 0 |
| Mean client response time | 914.54 ms | 419.24 ms |
| Client response p99 | 2,729.15 ms | 1,123.83 ms |

There were no recorded polling errors, Nginx upstream timeouts or no-live-upstream
events. Final metrics collection and the committed-order observer succeeded.
Each API recorded 5,013 completed all-route requests; mean handling time was
10.12 ms on API 1 and 10.36 ms on API 2. The weighted 10.24-ms mean includes
pool waiting, excludes time before handler execution and is not purchase-only
CPU time. Busy counts combine the HTTP guard and acquisition expiry; this run
does not isolate their respective contributions.

Compared with 1/1, this run eliminated purchase 504s, reduced busy count and
client latency, and kept order p99 nearly unchanged. API handling mean increased;
the response mix and number of requests reaching the API also changed. These
single shared-host runs do not establish the cause of that increase or a general
scaling curve. The library-default acquisition timeout and operation deadline
were unchanged. No source changes or commit were made during the run. Isolated
services were cleaned up.

[2/1 summary](evidence/built-in-admission-pool/2api-summary.json) and
[raw evidence/source manifest](evidence/built-in-admission-pool/manifest.json)
preserve the results. Evidence hashes, current source identity and 10,000-response
accounting were verified.


## Built-in pool 3/1 spike

On 17 October 2026 at 10:47 Jakarta time, repeated the same 100-stock,
10,000-unique-request, one-second spike with 3 APIs / 1 worker. The final write
was at 901.56 ms. The command exited 0 with valid_dispatch and all correctness
and order-latency gates passed. All 100 admissions became committed orders.

| Measurement | Built-in pool 2/1 | Built-in pool 3/1 |
| --- | ---: | ---: |
| Committed orders / admissions | 100 / 100 | 100 / 100 |
| Admission-to-durability p99 | 384.18 ms | 560.06 ms |
| Admission-to-durability maximum | 384.18 ms | 560.06 ms |
| Mean API handling time | 10.24 ms | 10.86 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 8,351 | 9,298 |
| 429 busy | 1,549 | 602 |
| 504 gateway timeout | 0 | 0 |
| Mean client response time | 419.24 ms | 182.45 ms |
| Client response p99 | 1,123.83 ms | 1,067.70 ms |

All 602 busy responses are accounted for by the HTTP guard's metric deltas:
API 1: 270, API 2: 97, API 3: 235. Their sum equals all purchase
429 responses; none are attributable to Redis acquisition expiry in this run.
There were no polling errors, Nginx upstream timeouts or no-live-upstream events.
Final metrics and the committed-order observer succeeded.

The weighted API mean covers 10,034 completed all-route requests, including pool
waiting, and excludes pre-handler delay. Compared with 2/1, fewer requests were
rejected busy and client latency decreased, while order p99 increased but remained
well below two seconds. Single shared-host runs do not isolate the cause of the
order-latency change or establish a general scaling curve. Pool policy and operation
deadline were unchanged. No source changes or commit were made; isolated services
were cleaned up.

[3/1 summary](evidence/built-in-admission-pool/3api-summary.json) and
[raw evidence/source manifest](evidence/built-in-admission-pool/manifest.json)
preserve the result. Evidence hashes, source identity and response accounting
were verified.


## Purchase lease instrumentation and sizing

Subsequent work moved purchase reply parsing outside the lease and measured
acquisition wait separately from lease duration. A 3/1 comparison of 8, 16 and
32 API connections, including invalid attempts and polling limitations, is in
[Redis lease sizing](redis-lease-sizing.md). Earlier tables retain their original
source revisions and do not measure this instrumentation/parsing change.
