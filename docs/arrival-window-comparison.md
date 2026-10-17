# 6 APIs / 1 worker: 10,000 requests over 1 versus 2 seconds

Requested on 17 October 2026 (Asia/Jakarta), using application commit `1a2dd66`
with the Redis-only purchase path and Redis-backed sale configuration reads.
The only harness addition is an optional `spike-10k-2s` scenario. It preserves
100 stock, 10,000 unique buyers, 10,000 preconnected sockets, expected full sale,
p99 < 2,000 ms and every admitted order <= 10,000 ms. It is excluded from the
default suite; the original spike is unchanged.

Each run starts fresh isolated PostgreSQL, Redis primary plus asynchronous
replica, six APIs, one worker and Nginx. Each service retains one CPU / 512 MiB.
Runs execute sequentially with socket recovery time between them. This is a
single shared-host comparison, not statistical proof of a capacity threshold.

The harness schedules arrivals over 90% of the dispatch deadline: 900 ms versus
1,800 ms. Every request must actually be written before the respective 1,000-ms
or 2,000-ms deadline. These windows measure request dispatch, not response times
or the instant Redis executes admission. Admission-to-durable timing begins at
Redis admission and ends at first observed PostgreSQL committed visibility,
including the existing approximately 25-ms observation/query delay.

```sh
STRESS_API_REPLICAS=6 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k

STRESS_API_REPLICAS=6 STRESS_WORKER_REPLICAS=1 \
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 pnpm test:stress spike-10k-2s
```

## Results

| Measurement | 1-second dispatch | 2-second dispatch |
| --- | ---: | ---: |
| Started, 17 October Asia/Jakarta | 00:45:36 | 00:47:33 |
| Last request write | 905.59 ms | 1,802.79 ms |
| Valid dispatch | yes | yes |
| Admissions / committed orders | 100 / 100 | 100 / 100 |
| Admission-to-committed-order visibility p50 | 1,716.47 ms | 4,541.11 ms |
| p95 | 4,027.54 ms | 5,843.27 ms |
| p99 | 4,081.22 ms | 5,851.27 ms |
| Maximum | 4,081.22 ms | 5,892.61 ms |
| Purchase HTTP response p99 | 4,738.96 ms | 4,087.72 ms |
| Busy | 8,898 | 6,878 |
| Sold out | 1,002 | 2,836 |
| Purchase HTTP 504 | 0 | 186 |
| Overall | failed order p99 gate | failed order p99 gate |

Both runs completed measurement with runStatus=valid_dispatch and passed=false.
The only false final invariant was orderP99UnderTwoSeconds. Every acknowledged
admission became exactly one committed order; stock reached zero without
overselling, pending entries drained and all orders completed within 10 seconds.
The last admission occurred 1,072 ms and 495 ms after the respective Redis
dispatch anchor. A valid write window does not require Redis execution within
that same window: the 1-second run wrote all requests in time but admitted the
last buyer later.

Final proxy and all six direct API metrics succeeded in both runs. The 186
purchase 504s in the 2-second case were upstream connection timeouts. The
1-second case had one order-poll fetch timeout; the 2-second case had no polling
errors. No proxy, retry policy, worker count, application limit or order SLO was
changed between cases.

Spreading requests over twice the window reduced explicit busy responses and
HTTP response p99 in these runs, but increased observed durable-order p99 by
about 1.77 seconds (43%) and introduced purchase gateway errors. It did not fix
the durability SLO. This is one sequential shared-host pair: it does not prove
that a wider arrival window inherently worsens processing. Worker-stage,
Redis/network and host-scheduling timings are still needed to explain the
counterintuitive order-latency result. No causal attribution is made from this pair.

## Evidence and harness verification

[1-second summary](evidence/arrival-window-comparison/1s-summary.json),
[2-second summary](evidence/arrival-window-comparison/2s-summary.json) and
[manifest](evidence/arrival-window-comparison/manifest.json) retain raw request
records, committed visibility observations, configurations, host/resource samples,
service logs and runner output. The application revision is 1a2dd66; the working
tree contains only the comparison harness/docs/evidence and unrelated .DS_Store.
The implementation source bundle identifies the complete measured source.

All 21 harness tests and lint passed. The new harness regression confirms the
2-second case is optional and preserves stock, request count, unique identities
and order gates. Source identity, raw dispatch/outcome accounting, stock/order
invariants and compressed evidence sizes/SHA-256 are checked independently.
No additional application change or commit was made for this comparison.
