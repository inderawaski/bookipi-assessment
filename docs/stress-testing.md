# Stress testing

## Outcomes

### Test environment

These seven workloads were run against the current implementation, with six pre-scaled API replicas and one worker throughout. Each workload used a fresh isolated sale and data volumes.

| Setting                | Measured environment                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Generator host         | Apple M4 Pro, 12 logical CPUs, 24 GiB RAM                                              |
| Generator OS / runtime | macOS, Darwin 25.5.0; Node v22.23.2                                                    |
| Docker VM              | Linux ARM64; 12 CPUs; 7.748 GiB RAM; Docker Engine 29.7.2                              |
| Application fleet      | Six API replicas, one worker                                                           |
| Container budgets      | Each API, worker, PostgreSQL and Redis: 1 CPU / 512 MiB; stress proxy: 1 CPU / 512 MiB |
| Redis                  | One primary and one asynchronous read-only replica; AOF everysec; noeviction           |
| Preconnected sockets   | 100 for no-oversell/duplicates; 1,000 for sufficient-stock; 5,000 for each burst       |
| Host isolation         | Generator and services shared the physical host with other running projects            |

### Allocation and dispatch

| Test               | Requests | Unique buyers | Initial stock | Write deadline | Last write (ms) | Committed orders | Remaining stock | Result |
| ------------------ | -------: | ------------: | ------------: | -------------- | --------------: | ---------------: | --------------: | ------ |
| `no-oversell`      |      100 |           100 |            10 | 1 s            |           12.29 |               10 |               0 | Pass   |
| `duplicates`       |      100 |            10 |            10 | 1 s            |           11.07 |               10 |               0 | Pass   |
| `sufficient-stock` |    1,000 |         1,000 |         1,000 | 1 s            |          900.54 |            1,000 |               0 | Pass   |
| `normal-burst`     |    5,000 |         5,000 |           100 | 10 s           |        8,999.60 |              100 |               0 | Pass   |
| `aggressive-burst` |    5,000 |         5,000 |           100 | 3 s            |        2,700.68 |              100 |               0 | Pass   |
| `extreme-burst`    |    5,000 |         5,000 |           100 | 1 s            |          900.73 |              100 |               0 | Pass   |
| `spike-10k`        |   10,000 |        10,000 |           100 | 1 s            |          901.81 |              100 |               0 | Pass   |

All offered requests were written before their deadlines and received responses. All seven runs passed stock conservation, allocation/order uniqueness, mapping and admission-time checks, acknowledgement preservation and complete queue drain. No overselling occurred.

### HTTP outcomes

| Test               | Queued | Sold out | Already placed | Other outcomes | Proxy / transport errors |
| ------------------ | -----: | -------: | -------------: | -------------: | -----------------------: |
| `no-oversell`      |     10 |       90 |              0 |              0 |                        0 |
| `duplicates`       |     10 |        0 |             90 |              0 |                        0 |
| `sufficient-stock` |  1,000 |        0 |              0 |              0 |                        0 |
| `normal-burst`     |    100 |    4,900 |              0 |              0 |                        0 |
| `aggressive-burst` |    100 |    4,900 |              0 |              0 |                        0 |
| `extreme-burst`    |    100 |    4,900 |              0 |              0 |                        0 |
| `spike-10k`        |    100 |    9,900 |              0 |              0 |                        0 |

The duplicate workload submitted ten distinct request keys for each of ten buyer identifiers. It committed one order per buyer and rejected the other attempts as already placed. The sufficient-stock workload committed all 1,000 orders; its harness pass does not require full allocation or the spike latency gates.

### Latency

| Test               | HTTP p50 (ms) | HTTP p95 (ms) | HTTP p99 (ms) | Order visibility p99 (ms) | Order visibility maximum (ms) |
| ------------------ | ------------: | ------------: | ------------: | ------------------------: | ----------------------------: |
| `no-oversell`      |         79.35 |         94.07 |         95.69 |                         — |                             — |
| `duplicates`       |         44.16 |        102.26 |        103.05 |                         — |                             — |
| `sufficient-stock` |          1.19 |          2.16 |         13.45 |                    766.82 |                        774.82 |
| `normal-burst`     |          0.99 |          1.82 |          4.27 |                         — |                             — |
| `aggressive-burst` |          1.11 |          7.14 |         34.13 |                         — |                             — |
| `extreme-burst`    |          5.03 |         64.13 |         89.53 |                         — |                             — |
| `spike-10k`        |        204.23 |        315.09 |        374.19 |                  1,313.40 |                      1,313.40 |

Order visibility timing was recorded for sufficient-stock and spike-10k. A dash means that order timing was not collected for that workload. These values include the delay until an independent PostgreSQL observer first saw the committed order.

The spike-10k run passed its additional gates: all 100 units committed, zero proxy/transport errors, order visibility p99 below 2,000 ms and every admitted order visible within 10,000 ms. HTTP response latency is separate from the request-write deadline.

These are single-run outcomes on the recorded shared local environment. They establish the observed results at this resource budget, not guaranteed production throughput or crash-safe admission durability.
