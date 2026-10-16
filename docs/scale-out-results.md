# Spike scale-out experiment

> Historical measurements: these runs used the WAITAOF-based acknowledgement
> design. The subsequent immediate-acknowledgement/one-Redis-replica decision
> supersedes that design; these results do not measure the new implementation.

## Question and rationale

Does adding API or worker replicas improve the 100-stock / 10,000-unique-buyer
one-second spike, and which shared dependency becomes a likely constraint?

The admission path has 16 concurrent durability operations per API instance.
Each operation holds its slot while Redis confirms persistence through WAITAOF.
Adding API replicas increases the number of admission slots. If admissions rise,
the baseline's per-instance admission bound is a practical constraint; it does not
establish that the Redis Lua stock check was saturated.

Workers finish admitted purchases asynchronously. Adding worker replicas tests
whether parallel processing reduces queue waiting and committed-order latency.
Increasing APIs alone can increase backlog without increasing worker throughput.
Scaling both together obscures which change helped, so the experiment varies them
independently before testing their combined effect.

If improvement plateaus, Redis is a stronger hypothesis, not a proven cause.
WAITAOF persistence latency can dominate while Redis CPU stays low. PostgreSQL,
ingress, the generator and contention on the shared Docker host remain possible
constraints. This is a capacity experiment, not permission to weaken durability.

## Method

Run the following sequentially with `A/W` equal to `1/1`, `3/1`, `1/3`, `3/3`:

```sh
STRESS_CONNECTIONS=10000 STRESS_MAX_CONNECTIONS=10000 \
STRESS_API_REPLICAS=A STRESS_WORKER_REPLICAS=W pnpm test:stress spike-10k
```

Each attempt creates a fresh isolated Compose project, fresh sale and dedicated
volumes. Redis, PostgreSQL and ingress budgets, persistence, application concurrency
limits and workload remain fixed. Each added API or worker has its own CPU/memory
budget, so total application resources increase. The generator uses 10,000
preconnected sockets in every comparison and reuses them; every one of the 10,000
request writes must still finish inside one second. Offered work is scheduled over
900 ms independently of responses. There are no automatic purchase retries.
Invalid dispatch/setup attempts cannot establish comparative server capacity.
Initial 1,000- and 5,000-socket baselines missed the one-second dispatch deadline;
these calibration attempts are retained separately and excluded from the matched
capacity comparison. The full matrix is rerun at a fixed 10,000-socket budget.
Between configurations, drain time plus an explicit recovery wait provides at
least 65 seconds after burst responses for socket recovery.

The acceptance criteria remain: fill all 100 units, preserve all correctness
invariants, admission-to-committed-order visibility p99 under 2,000 ms, and every
admitted order visible within 10,000 ms. Visibility sampling uses PostgreSQL's clock
approximately every 25 ms; it is an upper bound including sampling/query delay.
The diagnostic drain can continue up to 300 seconds without relaxing these targets.

Compare admissions/orders, busy responses, gateway errors, committed-order latency,
queue drain, durability-barrier waits and CPU/resource samples. HTTP response
percentiles alone are unsuitable: fast busy responses can dominate them. API
metrics cover every replica; worker before/after barrier metrics sample the first
worker only and must not be treated as an aggregate of all workers.

The initial matrix used one run per configuration on a shared local host. A
follow-up repeats 3/3 before 3/1 to investigate ordering sensitivity (see below).
These are limited repeats, without randomized run order or statistical confidence
intervals. Differences are observational evidence, not a production capacity
guarantee. Resolved configurations, source snapshots, exact
host details, raw request records and service/resource logs are retained per run.

## Results

Measurements: **16 October 2026, Asia/Jakarta**. The four matched runs used
10,000 preconnected sockets, the Apple M4 Pro host (12 logical CPUs, 24 GiB RAM),
macOS Darwin 25.5.0 and Node 22.23.2. Each API, worker, Redis, PostgreSQL and stress
proxy has a one-CPU / 512-MiB limit. Resolved Compose and host configuration is
archived with each attempt. Other pre-existing containers remained running.

| API / workers | Last write ms | Orders / 100 | Busy | HTTP 504 | Order p99 s | Order max s | Drain after responses s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [1 / 1](evidence/scale-out/flash-test-74ae3edb-1a1d-4377-9206-03b96b455f42/spike-10k/result.json.gz) | 903.57 | 43 | 7,797 | 2,160 | 84.63 | 84.63 | 82.40 |
| [3 / 1](evidence/scale-out/flash-test-c405d490-cf0a-4e58-b334-09941eb65157/spike-10k/result.json.gz) | 900.79 | 100 | 9,846 | 28 | 200.07 | 202.03 | 199.75 |
| [1 / 3](evidence/scale-out/flash-test-57f096c7-b7fd-4392-ba22-febcb169c530/spike-10k/result.json.gz) | 901.39 | 49 | 8,378 | 1,588 | 38.58 | 38.58 | 36.90 |
| [3 / 3](evidence/scale-out/flash-test-78c93a57-a2f2-40c2-93f9-a942fe8ae164/spike-10k/result.json.gz) | 900.99 | 69 | 9,931 | 0 | 54.05 | 54.05 | 51.85 |

**Every final run had valid dispatch and passed correctness/reconciliation:**
no overselling, unique allocations/orders, stock conservation, matching admission
timestamps, preserved durable acknowledgements and fully drained admitted work.
**None passed the complete spike requirement.** Every configuration failed both
latency targets; only 3 APIs / 1 worker filled all 100 units. A nonzero stress
command exit is the expected acceptance failure, not a setup failure.

HTTP outcome accounting is retained in the summary and raw records. In 3/1, the
remaining 26 requests received `sold_out`; in 1/3, 34 queued/delayed responses plus
15 admissions whose responses timed out account for 49 orders. A 504 does not
prove the purchase was rejected. In 3/3, all 69 admissions were acknowledged and
the other 9,931 requests received explicit `busy`; 31 units remained unallocated.

### Durability and resource observations

| API / workers | API barrier mean ms (all replicas) | First worker barrier mean ms | Peak API CPU % | Peak Redis CPU % |
| --- | ---: | ---: | ---: | ---: |
| 1 / 1 | 997.2 | 1017.2 | 100.54 | 22.92 |
| 3 / 1 | 910.9 | 1022.6 | 102.66 | 35.28 |
| 1 / 3 | 968.6 | 1023.4 | 96.47 | 6.21 |
| 3 / 3 | 1001.3 | 1004.3 | 82.41 | 10.03 |

Barrier means use before/after sum/count deltas, not percentiles. Worker means
cover the first worker only. CPU numbers are sampled peaks of an individual
container, not sums or simultaneous peaks; 100% represents one CPU. Sampling can
miss brief spikes. Generator maximum event-loop delay was 21.7–44.8 ms in the
matched runs. Resource logs cover every container.

## Interpretation

1. **API scale-out improved admission in this experiment.** Moving from 1/1 to
   3/1 increased orders from 43 to 100 and reduced HTTP 504s from 2,160 to 28.
   More API capacity and admission slots helped; this does not distinguish API
   request CPU, connection/setup work and durability-slot occupancy individually.
2. **API scale-out alone increased worker backlog.** With one worker, 100 orders
   took about 202 seconds at the tail, versus 84.6 seconds for 43 orders. The
   roughly two-second per-order progression is consistent with the serial worker
   flow and its persistence waits. More admissions alone did not speed completion.
3. **Worker scale-out improved processing.** At one API, three workers reduced
   p99 from 84.6 to 38.6 seconds while completing 49 rather than 43 orders. At
   three APIs, three workers completed 69 orders with a 54.0-second tail versus
   100 orders with a 202.0-second tail for one worker. These populations differ,
   so the raw p99/drain ratios are not controlled equal-backlog speedup ratios.
4. **The initial allocation ranking was not stable.** The original 3/3 run
   admitted 69, fewer than 3/1's 100, despite valid dispatch and no HTTP 504s.
   Reversing the order produced 100 for 3/3 and 90 for 3/1. There is no evidence
   here that three workers inherently worsen admission contention. The exact
   cause of variability requires stage-level tracing and more controlled repeats.
5. **Redis is not isolated as the sole bottleneck.** Durability barriers remain
   around one second even after scaling, so persistence-wait cadence is a strong
   remaining constraint hypothesis. Redis sampled CPU stayed below its quota,
   while APIs reached their quotas in some configurations. This is not evidence
   of saturated Redis Lua execution or physical disk capacity. PostgreSQL and
   shared-host effects are also not ruled out.

The experiment demonstrates useful API and worker scaling effects, but
**replicas alone do not meet p99 < 2 seconds or maximum <= 10 seconds**. The next
investigation should repeat the matched runs, measure stage-level Lua/connection/
WAITAOF/database-commit timings and test equal admitted backlogs for workers.
Changes to persistence, admission concurrency or durable batching require their
own correctness and crash-recovery verification; none were changed here.

## Reverse-order follow-up: 3/3 before 3/1

The user challenged interpreting 69 versus 100 orders as a worker-contention
effect and requested 3/3 before 3/1. The same spike, 10,000-socket cap, persistence
settings and resource limits were retained. Both cases used new isolated projects.
The first case drained for more than 65 seconds after burst responses, so no
additional socket-recovery wait was necessary before the second case.

| Sequence | APIs / workers | Last write ms | Admissions = orders | Within first second | Later admissions | Order p99 s | HTTP 504 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original | [3 / 1](evidence/scale-out/flash-test-c405d490-cf0a-4e58-b334-09941eb65157/spike-10k/result.json.gz) | 900.79 | 100 | 48 | 52 | 200.07 | 28 |
| Original | [3 / 3](evidence/scale-out/flash-test-78c93a57-a2f2-40c2-93f9-a942fe8ae164/spike-10k/result.json.gz) | 900.99 | 69 | 48 | 21 | 54.05 | 0 |
| Reversed | [3 / 3](evidence/scale-out/flash-test-6f8fe1c0-1a94-4590-923b-8b7abe653137/spike-10k/result.json.gz) | 902.83 | 100 | 48 | 52 | 73.21 | 195 |
| Reversed | [3 / 1](evidence/scale-out/flash-test-54210645-0e92-460a-927b-ebc4439ad79b/spike-10k/result.json.gz) | 902.04 | 90 | 48 | 42 | 182.49 | 0 |

All four runs in this table had valid dispatch. All admitted purchases became
unique committed orders; no admitted work remained pending. Both reversed runs
failed the unchanged latency acceptance targets. Reversed 3/3 filled stock;
reversed 3/1 left ten units unallocated.

**Correction to the bottleneck interpretation:** three APIs provide 48 concurrent
admission operations, not a fixed 48 requests/second. Slots are held across Redis
connection/setup, Lua and durability confirmation, and new purchases are rejected
when slots are occupied. The gate is a direct constraint on allocation. Eventual
completion of admitted purchases does not imply sufficient downstream throughput
to meet confirmation deadlines.

Every run in this table admitted exactly 48 buyers in the first second. The
allocation differences came entirely from later admissions. Although all request
writes completed within one second, dispatch is not server receipt or admission:
requests can remain delayed in the transport/proxy/API path. Last admission was
2,223 ms for original 3/1, 1,136 ms for original 3/3, 2,156 ms for reversed 3/3
and 2,193 ms for reversed 3/1, relative to the recorded Redis dispatch-time anchor.

The reversed result demonstrates that **3/3 can fill all 100 units** and that the
original 100-versus-69 ranking does not establish worse contention from additional
workers. It also does not prove run order alone caused the difference: AOF flush
phase, scheduling, upstream queueing and shared-host conditions were not isolated.
Per-request API receipt, gate acquisition/rejection, Lua completion, WAITAOF and
worker/commit timestamps would be needed to identify the specific cause.

Application logs record `busy` from `DurableAdmission.place` after the HTTP gate.
Because that capacity check runs before creating its Redis connection or calling
the reservation Lua, these log counts identify pre-Redis admission-gate rejection:

| Sequence | API / workers | Admission-gate busy log count |
| --- | --- | ---: |
| Original | 3 / 1 | 9,134 |
| Original | 3 / 3 | 8,591 |
| Reversed | 3 / 3 | 7,751 |
| Reversed | 3 / 1 | 7,531 |

These counts are a subset of all buyer `busy` responses; the separate HTTP
concurrency gate also returns `busy`. In the reversed 3/3 run, all 195 proxy 504s
were connection timeouts; reversed 3/1 had none. No loss between admitted buyers
and final committed orders occurred in either run.

Four Docker CPU samples in the reversed 3/1 resource log contain `--`. They
remain in the raw archive and are counted as unavailable in the summary, not
treated as zero or used in peak CPU calculations. Purchase timings and accounting
are unaffected. The [reverse receipt](evidence/scale-out/reverse-experiment.json)
records order, configuration, project IDs, runner logs and timestamps.

## Calibration attempts and evidence

| Sockets | API / workers | Last write ms | Dispatch valid |
| ---: | --- | ---: | --- |
| 1,000 | [1 / 1](evidence/scale-out/flash-test-a3e56334-afeb-4509-895d-7edc7eeb7749/spike-10k/result.json.gz) | 1453.12 | no |
| 1,000 | [3 / 1](evidence/scale-out/flash-test-159ec98f-9552-4740-94d4-bc0018f0f3ba/spike-10k/result.json.gz) | 1549.12 | no |
| 5,000 | [1 / 1](evidence/scale-out/flash-test-9622040e-5352-40f7-91c1-687d203222c9/spike-10k/result.json.gz) | 1551.93 | no |
| 5,000 | [3 / 1](evidence/scale-out/flash-test-3b02e8c6-0444-4ddd-bf22-7e942f1fbdf1/spike-10k/result.json.gz) | 1273.31 | no |

All four calibration attempts are invalid as one-second performance evidence,
including those that eventually filled stock. They are retained, not silently
discarded or combined with the matched 10,000-socket results. Controllers stopped
launching further calibration cases after their baselines failed; active cases
were allowed to finish reconciliation and cleanup before the next experiment.

Raw artifacts for **all ten attempts** are compressed under
[evidence/scale-out](evidence/scale-out/manifest.json). The
[manifest](evidence/scale-out/manifest.json) records each original artifact's size
and SHA-256. [Summary JSON](evidence/scale-out/summary.json) retains all outcomes,
acceptance invariants and computed measurements.
[Final experiment receipt](evidence/scale-out/experiment.json) records commands
via their runner logs, replica counts, project IDs, exit codes and timestamps.
The two calibration receipts, reverse-order receipt and all runner logs are
retained alongside it. Summary entries identify their experiment receipt to
distinguish the initial matrix, reversed pair and invalid calibrations.

Decompress a linked result with `gzip -dc <path-to-result.json.gz>`. Source
snapshots and dirty/base-commit metadata identify the exact tested configuration.
No source behavior, durability settings or acceptance target was relaxed.
