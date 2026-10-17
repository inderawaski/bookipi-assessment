# Ten APIs / one worker: API handling-time measurement

> Historical measurements before connection pooling and removal of per-operation Redis health checks. See [the pooled follow-up](pooled-admission-results.md).

On 17 October 2026 (Asia/Jakarta), run the same 100-stock, 10,000-unique-request,
one-second workload with 10,000 preconnected sockets. Each service retains one
CPU / 512 MiB; total application resources rise with replica count. The only
additional harness change raises the API replica validation cap from eight to ten;
the worker cap remains eight. Application sources are unchanged from 1a2dd66.

```sh
STRESS_API_REPLICAS=10 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k
```

## API measurement

The before/after direct metrics from all ten APIs succeeded. For each API,
subtract flash_http_latency_seconds_sum and flash_http_latency_seconds_count
before the burst from their values afterward. Sum those deltas across replicas
and divide accumulated seconds by completed requests. This is a request-weighted
mean, not an unweighted average of replica means.

**407.3717 seconds / 8,037 completed HTTP requests = 50.69 ms/request.**

This is Fastify elapsed wall time for completed requests, including Redis waits
and other handler delays; it is not CPU time. It mixes purchase, polling, health
and metrics routes and does not provide a separate admitted-purchase average.
It excludes latency before Fastify begins handling and does not represent every
request that timed out or disconnected without a completed-response metric.

| Same one-second workload | Completed HTTP requests in metric delta | Weighted API mean handling time |
| --- | ---: | ---: |
| Earlier 1/1 matrix | 3,712 | 22.44 ms |
| Earlier valid 6/1 matrix | 10,051 | 26.72 ms |
| New 10/1 | 8,037 | 50.69 ms |

These are different runs with different rejection/timeout mixes. Their averages
do not isolate scaling overhead or prove a downstream/CPU bottleneck.

| API replica | Completed HTTP requests | Mean handling ms |
| --- | ---: | ---: |
| 1 | 803 | 50.70 |
| 2 | 804 | 47.76 |
| 3 | 803 | 51.75 |
| 4 | 803 | 50.90 |
| 5 | 804 | 51.97 |
| 6 | 804 | 48.19 |
| 7 | 804 | 47.23 |
| 8 | 803 | 53.12 |
| 9 | 803 | 54.07 |
| 10 | 806 | 51.18 |

## Workload results

| Measurement | Result |
| --- | ---: |
| Last request write | 900.79 ms — valid |
| Admissions / committed orders | 100 / 100 |
| Admission-to-committed-order visibility p99 | 3,978.92 ms |
| Maximum order latency | 3,981.92 ms |
| Client mean response time, all 10,000 requests | 4,126.38 ms |
| Client response p99 | 4,685.23 ms |
| Busy / sold out | 5,658 / 2,205 |
| Purchase HTTP 504 | 2,037 |
| Overall | measurement_failed; order p99 gate also false |

Every recorded stock/order invariant except p99 < 2,000 ms passed. All admitted
orders committed exactly once, no stock was oversold, pending work drained and
all orders finished within ten seconds. The 2,037 purchase 504s were upstream
connection timeouts. One polling request timed out and two polling responses were
non-JSON gateway errors.

The final proxy-routed metrics request failed with Nginx logging no live upstreams,
after all ten direct API metrics had been collected. The harness retained
runStatus=measurement_failed and exited nonzero. That does not invalidate the
available direct API timing deltas, but this is not a complete passing stress run.
No timeout, concurrency limit or proxy policy was relaxed to make it pass.

[Structured summary](evidence/10api-processing-time/summary.json) and
[compressed evidence manifest](evidence/10api-processing-time/manifest.json)
retain raw request/visibility records, per-API metrics, host/configuration/source
metadata, service/resource logs and runner output. Runtime source identity,
request accounting, metric deltas and compressed hashes are independently checked.
No commit or deployment is made for this measurement task.
