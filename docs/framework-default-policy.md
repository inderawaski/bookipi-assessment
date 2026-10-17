# Framework default concurrency policy

User approved on 17 October 2026. Services no longer impose the application HTTP
concurrency guard. Fastify handles incoming requests under its normal concurrency
policy. Active and peak request metrics remain observational; they do not reject
requests or reserve a fixed number of HTTP slots.

Redis admission uses createClientPool without any pool options. The installed
redis@6.3.0 defaults are minimum 1, maximum 100, acquisition timeout 3,000 ms and
idle cleanup delay 3,000 ms. The service connects the default minimum at startup;
the library grows and shrinks the pool. HTTP_CONCURRENCY, ADMISSION_CONCURRENCY
and STRESS_ADMISSION_CONCURRENCY were removed from active configuration, Compose
and example environment files. Explicit small maxima are allowed only in test
mode for deterministic contention/timeout fixtures.

Busy purchase responses now originate from Redis acquisition expiry before Lua;
there is no immediate rejection from an HTTP concurrency guard. Framework defaults
still have resource and timeout limits. Existing Redis operation deadline,
disabled offline buffering/automatic replay, uncertainty handling, shutdown
cancellation, request-size limits and HTTP/gateway timeouts remain. Parsing stays
outside the purchase lease, with separate acquisition/lease measurements.

## Verification

Passed 76 unit tests, 56 integration tests, 22 crash/network tests, 21 harness
tests, typecheck, lint and build. A unit test holds 100 HTTP handlers concurrently
and verifies all proceed successfully beyond the former 64-request cap. Another
asserts createClientPool receives only client options, with no pool-options
argument. Real Redis coverage verifies the default one-socket warmup, socket reuse
and shutdown; contention fixtures retain safe expiry and no-late-send coverage.
An initial integration expectation of two warm sockets was updated to match the
new default minimum, then the full integration suite passed.

Review checked removal of rejection hooks and configuration plumbing, metrics
without enforcement, service startup paths, fixture-only overrides, and retention
of uncertainty and crash behavior. [Archived logs and source snapshot](evidence/framework-default-policy/manifest.json)
retain the verified revision. Historical stress and sizing reports describe their
original settings; no default-policy spike was run in this change. No commit was
made.


## 1/1 default-policy spike

On 17 October 2026 at 11:22 Jakarta time, ran 1 API / 1 worker with 100 stock
and 10,000 unique purchase requests, scheduled over 900 ms with a one-second
write deadline. The final write occurred at 900.92 ms. The command exited 0 with
valid_dispatch and all correctness and order-latency gates passed.

| Measurement | Previous built-in pool, HTTP guard 64, pool maximum 16 | Framework defaults, no HTTP guard |
| --- | ---: | ---: |
| Admissions / committed orders | 100 / 100 | 100 / 100 |
| Admission-to-durability p99 | 388.54 ms | 273.48 ms |
| Admission-to-durability maximum | 413.46 ms | 276.47 ms |
| Mean API handling time | 6.07 ms | 5.39 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 6,388 | 7,209 |
| 429 busy | 2,548 | 0 |
| 504 gateway timeout | 964 | 2,691 |
| Mean client response time | 914.54 ms | 1,494.17 ms |
| Client response p99 | 2,729.15 ms | 2,755.84 ms |

All 2,691 purchase 504s were Nginx timeouts while connecting to the API. There
were no recorded polling errors or Redis acquisition expiries. Final metrics
and the independent committed-order observer succeeded. The combined number
of purchase 429/504 responses fell from 3,512 to 2,691, while mean client latency
increased. Passing order gates does not establish acceptable HTTP availability
for every buyer.

Across 7,309 purchase leases, mean hold time was 5.19 ms, observed maximum
73.44 ms and histogram p95 upper bucket 25 ms. Mean acquisition wait was
0.0415 ms, maximum 35.28 ms and p95 upper bucket 0.25 ms. Pool peak active leases
were 87; HTTP peak active handlers were 88. These peaks do not measure the total
number of connections ever opened. All leases had returned by final sampling.
The API mean covers 7,342 completed all-route requests, including acquisition
wait, and excludes pre-handler/network waiting; it is not purchase-only CPU time.

The Redis pool did not reach its 100-active-lease maximum in the measured peak
and acquisition wait was small. Recorded purchase 504s occurred at the proxy's
upstream connection stage, rather than as Redis-pool acquisition failures.
These measurements do not identify the underlying cause of upstream connection
delay. Compared revisions also differ in parsing/instrumentation, and the results
are single shared-host runs; no causal attribution to guard removal alone is made.

[Run summary](evidence/framework-default-policy/1api-summary.json),
[previous 1/1 summary](evidence/built-in-admission-pool/1api-summary.json), and
[raw evidence/source manifest](evidence/framework-default-policy/manifest.json)
preserve the measurements. Source identity, evidence hashes, resolved configuration
and response accounting were verified. Services were cleaned up. No commit was made.


## 2/1 default-policy spike

On 17 October 2026 at 11:24 Jakarta time, repeated the same 100-stock,
10,000-unique-request spike with 2 APIs / 1 worker. The last write was at 901.93 ms,
satisfying the one-second dispatch requirement. All recorded correctness and
order-latency gates passed; all 100 admissions became committed orders.

| Measurement | Defaults 1/1 | Defaults 2/1 |
| --- | ---: | ---: |
| Committed orders | 100 | 100 |
| Admission-to-durability p99 | 273.48 ms | 364.17 ms |
| Mean API handling | 5.39 ms | 7.75 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 7,209 | 9,363 |
| 429 busy | 0 | 0 |
| 504 gateway timeout | 2,691 | 537 |
| Mean client response | 1,494.17 ms | 858.52 ms |
| Mean purchase lease | 5.19 ms | 7.51 ms |
| Mean acquisition wait | 0.0415 ms | 0.0474 ms |

The overall run **failed final metrics collection through Nginx**, with
runStatus measurement_failed and command exit 1. It must not be described as an
overall passing test. Direct metrics from both APIs had already been captured,
so the API and Redis measurements above remain available. There were three
polling JSON parse errors from HTML responses. The independent committed-order
observer remained healthy.

All 537 purchase 504s were Nginx timeouts connecting to an API. Four no-live-upstream
events were also logged. No Redis acquisition expired. Peak active leases were
76 and 78 on the APIs,
below the library's default maximum 100 each; all leases had returned by final
sampling. Purchase lease counts summed to 9,463, matching 100 processing plus
9,363 sold-out responses. API handling measurements include all completed routes
and pool waiting, excluding pre-handler delay; lease measurements include network
and event-loop delay. Single shared-host runs do not isolate the cause of the
order/lease latency increases, although purchase 504s and mean client latency
were lower than 1/1.

[2/1 run summary](evidence/framework-default-policy/2api-summary.json) and
[raw evidence/source manifest](evidence/framework-default-policy/manifest.json)
preserve the failed measurement and captured results. Evidence hashes, source
identity, replica settings and response accounting were verified. Services were
cleaned up. No source changes or commit were made during the run.


## 3/1 default-policy spike

On 17 October 2026 at 11:26 Jakarta time, repeated the same 100-stock,
10,000-unique-request spike with 3 APIs / 1 worker. The last write occurred at
900.82 ms, within the one-second deadline. The command exited 0 with valid_dispatch;
all correctness and order-latency gates passed and all 100 admissions committed.

| Measurement | Defaults 2/1 | Defaults 3/1 |
| --- | ---: | ---: |
| Committed orders | 100 | 100 |
| Admission-to-durability p99 | 364.17 ms | 846.38 ms |
| Mean API handling | 7.75 ms | 10.73 ms |
| 202 processing | 100 | 100 |
| 409 sold out | 9,363 | 9,900 |
| 429 busy | 0 | 0 |
| 504 gateway timeout | 537 | 0 |
| Mean client response | 858.52 ms | 750.11 ms |
| Client response p99 | 2,002.88 ms | 1,838.28 ms |
| Mean purchase lease | 7.51 ms | 10.05 ms |
| Mean acquisition wait | 0.0474 ms | 0.4724 ms |

No polling errors, Nginx upstream timeouts or no-live-upstream events were recorded.
Final proxy and direct metrics collection succeeded, unlike the 2/1 run's final
proxy measurement failure. All 10,000 purchase requests returned a business outcome.
There were no Redis acquisition expiries. Peak active leases were 75 / 100 / 100
per API; all returned by final sampling. Lease maximum was 135.93 ms and acquisition
maximum 126.88 ms; histogram acquisition p99 upper bucket was 10.5 ms.

More requests reached Redis and returned sold out, while lease duration, API
handling and admission-to-durability p99 increased. Order p99 remained below two
seconds and every order below ten seconds. These single shared-host comparisons
do not isolate the cause of increased downstream latency or establish a scaling
curve. API means cover completed all-route elapsed handling, while lease timing
includes network/event-loop delay; neither is Redis CPU time.

[3/1 summary](evidence/framework-default-policy/3api-summary.json) and
[raw evidence/source manifest](evidence/framework-default-policy/manifest.json)
preserve the results. Evidence hashes, source identity, replica settings and
response/lease accounting were verified. Services were cleaned up; no source
changes or commit were made during the run.


## Commit verification

Fresh verification before the checkpoint commit passed 76 unit tests, 21 harness
tests, 56 integration tests, 22 crash/network tests, lint, typecheck and build.
All 620 previously archived evidence hashes and the current implementation
snapshot were verified, along with local report links and whitespace checks.
[Fresh verification logs](evidence/commit-verification/manifest.json) retain the
pre-commit checks. The latest performance measurement remains the recorded 3/1
spike; performance tests were not repeated for this commit.
