# DEV-19 measured experiments

Measurements were taken on 16 October 2026 (Asia/Jakarta). Results describe this
local prototype and host; they are not evidence of 100,000 requests/second.
Human checkpoint F is **pending**. The full five-valid-burst requirement must not
be accepted unless every prescribed workload has a valid dispatch artifact.

## Prescribed workloads

**Three of five prescribed workloads have valid dispatch and passing invariants.**
The two 100,000-request workloads are outstanding; this ticket is not fully accepted.
All failed/setup attempts are indexed in [the complete attempt table](evidence/dev19/attempts.md).

| Workload | API / workers | Sockets | Last write ms | Orders | Valid burst |
| --- | --- | --- | --- | --- | --- |
| [stock100-1k](evidence/dev19/flash-test-bb3f2fd6-686b-4f8f-aab0-e8f26fae942e/stock100-1k/result.json.gz) | 1 / 1 | 1000 | 899.38 | 15 | yes |
| [stock100-10k](evidence/dev19/flash-test-0aefe7e8-9cc2-48d7-b060-7d88e55f6981/stock100-10k/result.json.gz) | 1 / 3 | 5000 | 947.11 | 47 | yes |
| [duplicates](evidence/dev19/flash-test-38d78af7-9ffd-44a9-84fb-ef50736bbb44/duplicates/result.json.gz) | 1 / 1 | 10000 | 900.97 | 45 | yes |
| [stock100-100k](evidence/dev19/flash-test-92a409c1-59bc-4bf7-8356-3458ed2d3a3a/stock100-100k/result.json.gz) | 1 / 1 | 10000 | 16547.24 | 100 | no |
| [stock10k-100k](evidence/dev19/flash-test-9053f623-70d3-4b8b-9e19-717e33a01a6e/stock10k-100k/result.json.gz) | 1 / 3 | 1000 | 9292.18 | 178 | no |

The valid 10,000-unique-buyer run used 5,000 sockets and three workers. Its
10,000 outcomes were 8,975 busy rejections, 21 uncertain confirmations, 26 queued/
delayed acknowledgements and 978 non-JSON proxy responses; all 47 admissions
completed. Dispatch validity does not mean every response succeeded or completed
within one second.

## Environment and reproducibility

The generator ran on macOS/Darwin 25.5.0, Apple M4 Pro (12 logical CPUs), 24 GiB RAM,
Node 22.23.2 and pnpm 11.25.0. Docker Desktop 4.88.1 / Engine 29.7.2 / Compose 5.4.0
used a Linux 7.0.12 VM with 12 CPUs and 7.748 GiB RAM, overlayfs and named volumes.
The host ephemeral-port range was 49,152–65,535; kernel file limits were 92,160 per process and 184,320 total. Physical disk/fsync device details were not available through these VM measurements. Other pre-existing containers were running; they were left untouched. These are
shared-host measurements, not a dedicated benchmark machine. `host.json.gz`
records limits, network counters, versions and, for later runs, the container list.

PostgreSQL 18.3 and Redis 7.4.8 each have one CPU and 512 MiB. Each API and worker
replica also has one CPU and 512 MiB. Application defaults remain HTTP concurrency
64, admission concurrency 16, admission timeout 3,000 ms, DB pool 10 per process,
dependency timeout 2,000 ms, retry attempts 5 / base 1,000 ms / cap 60,000 ms.
The generator's direct reconciliation pool is two connections with a 5,000 ms
deadline. Redis retains AOF everysec, noeviction and local WAITAOF confirmation.
No durability/fairness optimization was applied to application code.

The initial measurement proxy used the demonstration-sized 0.5 CPU / 64 MiB
budget and Nginx defaults. It spawned twelve workers and was OOM killed during a
10,000-request attempt. The revised **stress-only** proxy uses one CPU / 512 MiB,
one worker and 65,536 connection slots. This budget difference is explicit;
results must not be attributed to the smaller demonstration proxy. The original
failure is retained, including [Docker state](evidence/dev19/proxy-oom.json).

Run commands and scenario definitions are in the [harness guide](../scripts/stress/README.md).
Each attempt uses an isolated `flash-test-*` project, fresh sale and dedicated
volumes. The generator schedules all offered requests independently over 900 ms;
**every request finish/write must occur before 1,000 ms**. Responses and processing
may take longer. Preconnected sockets are reused; transport errors and missing
writes are explicit. The larger socket reruns retain the original attempts.

## Evidence and interpretation

[Compact measurements](evidence/dev19/summary.json) contain outcomes, latency
p50/p95/p99, dispatch span, generator CPU/memory/event-loop measurements,
replica counts, drain durations and invariant results. Latency percentiles cover completed HTTP responses; transport errors have no completion latency, and busy responses dominate saturated workloads. They are not admitted-order completion percentiles. [The manifest](evidence/dev19/manifest.json)
records every compressed artifact's original byte count and SHA-256. For example:

```sh
gzip -dc docs/evidence/dev19/flash-test-<uuid>/<scenario>/result.json.gz
```

Raw result files retain each input identity/key and scheduled/write/completion
timestamp, admission entries, identifier mappings, durable orders, remaining
stock, polls, failure timestamps and before/after metrics. Resource samples and
service logs are retained separately. Later runs also include exact harness/config
source snapshots, all API replica metrics and drain samples. Earlier attempts
predate some of these additions; their raw artifacts are preserved as generated.
The commit field identifies the base commit; a dirty working tree is recorded.

A failed generator/setup attempt is not a throughput result. A run with valid
dispatch but failed invariants is not a successful correctness result. Empty
admission sets are not proof of admission/recovery behavior. The first opening
attempt admitted nobody because pre-opening requests occupied all admission slots;
its replay assertion failed. The rerun uses 16 buyers/units to exercise both sides
of opening. The prescribed five workload sizes were never reduced.

The first 100,000-request / 10,000-stock attempt wrote its last dispatched request
at 1,842 ms and had a 762 ms generator event-loop delay. It also exceeded the
original 120-second drain deadline (61 orders at sampling). Its failed drain is
retained, not reported as success; later experiments use a 300-second bounded
drain. Raising sockets to 20,000 and 30,000 failed before dispatch with
`EADDRNOTAVAIL`. Several initial attempts were aborted during harness development by a Compose
profile mismatch; their setup errors are indexed and contribute no throughput
or correctness evidence. Another 100,000-request attempt exposed a generator error path
that exited before writing `result.json`; its runner error/service logs are retained and it
is invalid. A real-socket regression now verifies repeated socket errors and
bounded queued-request deadlines. One subsequent 10,000-socket preconnect timed
out; that attempt is also invalid.

A corrected stock-100 / 100,000-request attempt eventually produced 100 unique
orders, preserved all durable acknowledgements and drained in 181.73 seconds after
responses. Its last dispatch was **16,547 ms**, so it remains invalid as a one-second
burst (about 6,043 offered writes/second averaged over that stretched interval,
not a validated one-second throughput claim). Its outcomes included 86 uncertain confirmations and 24,339 non-JSON proxy
responses (17,745 HTTP 504 and 6,594 HTTP 502), retained individually with HTTP status. Eventual correctness does not
make that dispatch valid.

## Capacity findings

At the default one-API / one-worker budget, the valid sufficient-stock case
allocated 16 of 1,000 units: 984 explicit `busy` rejections account for the rest.
The response p50/p95/p99 were 7.69 / 140.03 / 2,183.10 ms; drain after responses was
30.77 seconds. This is saturation, not a claim that healthy capacity fills stock.
A separate eight-buyer/eight-unit workload checks full allocation below the gate.

For that sufficient-stock case, sampled peak API CPU was 49.87%, Redis 6.21%,
worker 10.70%, PostgreSQL 12.15%, and proxy 3.56%. API/worker barrier metrics were
roughly one second per confirmation, while DB pool waiting at the final sample was
zero. This supports bounded admission slots plus AOF confirmation cadence and
serial worker processing as the observed small-case limits. It does **not** prove
physical disk saturation or PostgreSQL write capacity: few orders reach the DB.
The 100,000-request invalid run reached about 100% of its API CPU quota and had
substantial generator event-loop delay; both ingress processing and generator
capacity require further isolation. Redis CPU was low in those samples. Docker
block I/O counters alone cannot separate fsync cadence from storage latency.

Potential follow-up work is to measure on a dedicated Linux generator/server,
size the admission pool and replicas from measured latency, and consider durable
batch processing only with fresh crash/fairness tests. Do not disable WAITAOF,
change persistence, reorder admission, or drop uncertain outcomes to improve a
benchmark number.

The final 10,000-stock / 100,000-request calibration used a 1,000-socket cap
and three workers. It dispatched all offered writes over 9,292 ms, so it is also
invalid for the prescribed one-second burst. All 178 admissions nevertheless
became unique durable orders, all durable acknowledgements were preserved, and
the queue drained in 112.36 seconds after responses. There were 146 uncertain
confirmations and 523 non-JSON proxy responses. This rerun supplies eventual
accounting evidence; it does not turn the earlier failed 120-second-drain attempt
into a successful run.

## Replica comparison

The final comparison holds stock/request/identity counts at 1,000/1,000/1,000,
uses the same proxy and **100 preconnected sockets**, and keeps every application
limit and persistence setting fixed. All comparison bursts satisfy the one-second
write condition and reconcile unique orders with their admissions. Initial replica
attempts during ephemeral-port exhaustion are retained as invalid setup attempts.

| API / worker replicas | Admissions / orders | Busy | Uncertain responses | Last write ms | Drain after responses ms |
| --- | --- | --- | --- | --- | --- |
| 1 / 1 | 16 | 984 | 1 | 900.83 | 30,956.55 |
| 3 / 1 | 48 | 952 | 1 | 899.76 | 96,297.03 |
| 3 / 3 | 47 | 953 | 0 | 900.07 | 40,961.98 |

Three APIs admit three times as many units, while one serial worker takes roughly
three times as long to drain. Each API has its own 16-slot admission bound; the
per-replica metric snapshots show the requests reached all three API instances.
Adding API replicas alone increases backlog rather than worker write throughput.
Three workers reduce drain from 96.30 to 40.96 seconds for nearly the same
allocation count (48 versus 47); the one-unit admission variation is accounted
for by the busy outcomes. This is a measured 2.35× drain-time improvement, not
a linear-scaling claim.

## Window and recovery results

The revised 16-buyer opening burst rejected eight requests as upcoming and admitted
eight after opening; all eight became durable orders. Dispatch straddled opening,
every admission timestamp was within the window, replay after closure succeeded,
and a fresh key after closure was rejected without adding a stream entry.
The closing burst also passed its window/replay checks.

The closing worker-crash burst began at 18:19:43.824 UTC. Docker confirmed the kill
at 18:19:44.282 (458 ms into dispatch), and worker readiness recovered at
18:19:48.965. All 16 admissions completed after closure, with a 57.22-second drain
measured after responses/recovery. This includes pending-work recovery delay, not
just container startup. Every durable acknowledgement was preserved. Post-close
replay succeeded and a fresh key was rejected as ended. Separate worker-crash and
three-burst replay experiments retain their exact outcomes and reconciliation in
the summary/raw artifacts. Polls include both successful statuses and overload
responses; a rejected poll does not revoke an admission.

## Verification

`pnpm build`, `pnpm typecheck` and `pnpm lint` passed. All 67 unit tests and all
10 harness tests passed. `pnpm test:integration` passed 40 tests in 119.62 seconds;
`pnpm test:failure` passed 26 tests in 209.60 seconds, covering SIGKILL admission
and worker boundaries, Redis durability/rewrite, network partitions, lost replies,
PostgreSQL restart and exhausted-work replay. Its [JSON report](evidence/dev19/failure-results.json)
is committed; recovery volumes remain available locally for
`flash-test-702119b4-24f6-4956-bcbe-010650e0c069` per the existing failure runner.
Socket-based tests initially hit sandbox `EPERM`; the successful runs used the
required local networking access. The closing-window assertion was mutation-tested:
changing `< endsAt` to `<= endsAt` failed the test, then the original code was restored.
No browser UI changed; browser tests were not rerun for this ticket.

## Review checkpoint

Review all attempts, including setup errors and dispatch-invalid runs, against the
raw timestamps. Check admitted timestamps against `[startsAt, endsAt)`, unique
allocations/orders, stock conservation, every durable acknowledgement, polling
outcomes, actual worker kill time, recovery and eventual drain. Confirm post-close
replay and post-close completion separately. The measured table below is an index;
the raw evidence and explicit invariant results decide acceptance.
