# One-second burst measurements (DEV-18)

Run `pnpm test:harness` for accounting and real TCP timing tests. Run
`pnpm test:stress stock100-1k` for the smallest full pipeline check, or
`pnpm test:stress` for all prescribed and additional cases. Docker must be running. Each case creates
its own randomly named `flash-test-*` Compose project and volumes, migrates and
initializes a fresh sale **before opening**, and waits on Redis TIME. Cleanup
explicitly deletes only that project's test volumes. No demonstration data is reset.

The five required scenarios are named `stock100-1k`, `stock100-10k`, `duplicates`,
`stock100-100k`, and `stock10k-100k`. `duplicates` uses exactly 100 identifiers,
100 times each, with 10,000 distinct request keys. Additional `new-key-duplicates`
and `same-key-retries` cases use identical identifier distributions but respectively
1,000 distinct keys and 100 repeated keys. These retries are scheduled requests in
the measured burst, not automatic retries after errors.

The generator uses Node's HTTP client and preconnects TCP sockets before the clock
starts. By default it allocates up to 10,000 sockets and reuses them for larger bursts. Unlike closed-loop VUs, it
schedules offered work independently of responses, over 900 ms of a 1,000 ms
window. Request `finish` timestamps record the point after connection acquisition
when the entire request has been handed to the OS for transmission. This is a
conservative dispatch upper bound; it is not a packet capture or proof of server
receipt. Loopback server tests independently record arrival times and demonstrate
that a queued request is rejected as invalid even when its iteration began on time.

`STRESS_CONNECTIONS=100 pnpm test:stress stock100-1k` deliberately reduces socket
capacity. An invalid run automatically queues a rerun with twice as many sockets (up to
30,000 or the request count) in a **fresh isolated project**. All attempts are
retained. A run that still fails at that capacity exits unsuccessfully:
raise file descriptor/ephemeral port limits or move to a larger generator host,
then rerun the same command. Do not quote an invalid run as achieved throughput.
100,000 simultaneous connections from one source address would exceed its TCP
port budget; larger bursts reuse sockets and still require every write to finish
inside the window. The runner makes scheduling limitations visible.
Measured execution and scaling evidence is in [DEV-19 results](../../docs/stress-results.md).

Artifacts are under `test-results/stress/<project>/<scenario>/`:

- `result.json`: settings, commit SHA, sale times, offered/dispatched/completed,
  dropped writes/iterations, invalid reasons, outcomes, p50/p95/p99 response
  latency, separate all-responses-within-one-second flag, every scheduled/write/
  completion timestamp, input keys, responses, generator CPU, memory, I/O bytes,
  event loop delay, queue drain duration and final DB/Redis evidence/invariants.
- `host.json`, `network-after.txt`: generator hardware, runtime, working tree state,
  descriptor limits and network counters before/after (host-wide counters include
  other traffic). `compose.yaml` records service resource limits and configuration.
- `resources.jsonl`: Docker CPU, memory, network and block I/O samples throughout
  the case; `services.log` retains application logs. `resources-errors.log`, if
  present, records sampler diagnostics.
- Metrics before/after retain API and worker barrier latency sums/counts, backlog,
  pending/delayed work, connection pools and process resources. Barrier latency
  is an aggregate mean from the sum/count delta, not a percentile measurement.

A setup/preconnect error is explicitly `invalid_generator_or_setup`. Missing
writes, writes outside the window, or inconsistent accounting invalidate dispatch.
Response timeouts/errors are counted independently; timely dispatch is valid even
when responses take longer than a second. A passing result also requires drained
work, stock conservation, unique allocations/orders, matching identifier/request
mappings and admission timestamps, and preservation of every durable acknowledgement.
Bounded overload rejections can make allocation lower than stock; no fill-rate
assumption is built into the invariant checks.

Queue drain starts after burst responses finish and is bounded at 300 seconds.
Reconciliation reads PostgreSQL and Redis directly. No purchase POSTs are issued
after the scheduled burst. Readiness probes and metrics GETs run outside the burst; DEV-19 adds concurrent order-status polling.
Redis uses the same AOF everysec/noeviction configuration and application WAITAOF
barriers as production; the harness asserts these settings before starting.

## DEV-19 experiments

The harness now routes through a dedicated Nginx proxy, so replica comparisons
exercise a common ingress. This measurement profile uses **one proxy CPU and
512 MiB**, one Nginx worker and 65,536 connection slots; it is a separate recorded
budget from the demonstration proxy. Application durability and overload settings
remain unchanged. `STRESS_API_REPLICAS` and `STRESS_WORKER_REPLICAS` accept 1–8.

```sh
pnpm test:stress stock100-1k stock100-10k duplicates stock100-100k stock10k-100k
pnpm test:stress healthy sufficient-stock opening closing closing-worker-crash worker-crash repeated
STRESS_API_REPLICAS=3 STRESS_WORKER_REPLICAS=1 pnpm test:stress sufficient-stock
STRESS_API_REPLICAS=3 STRESS_WORKER_REPLICAS=3 pnpm test:stress sufficient-stock
node scripts/stress/report.mjs test-results/stress/flash-test-<uuid>
```

`healthy` offers eight distinct buyers with eight units and asserts full allocation.
`sufficient-stock` offers 1,000 distinct buyers with 1,000 units, allowing saturation
at the default bounded admission concurrency instead of mostly sold-out reads.
Opening/closing experiments preconnect first, wait on Redis TIME, then aim to start
450 ms before the boundary. The actual first/last dispatch and Redis admission
timestamps must be inspected to confirm a straddle; a setup delay is not evidence
of a boundary test. Every run checks `startsAt <= admitted_at < endsAt`.
Boundary cases replay an admitted key after closure and require a completed order.

Polling runs concurrently with dispatch and drain at up to ten GETs/second for
`person-0`; each status/error and timestamp is retained. `repeated` makes three
bursts against the same sale with the same input keys, then reconciles all admissions
and acknowledged identities. These repeated bursts test replay, not three fresh
populations. `worker-crash` and `closing-worker-crash` request SIGKILL 200 ms after
dispatch begins, wait two seconds, start the worker, and drain. Actual kill/recovery
wall timestamps are recorded because Docker control latency can vary. The latter
case exercises recovery/completion after sale closure. Redis and DB failure
boundaries remain covered by `pnpm test:failure`.

The report command takes explicit isolated project paths and writes compressed
copies of **all** their files to `docs/evidence/dev19`, with an uncompressed SHA-256
manifest and compact summaries. Include failed attempts. Raw request timestamps
remain in `result.json.gz`; decompress with `gzip -dc`. The user confirmed human checkpoint F approval on 16 October 2026; see the
[reviewer record](../../docs/submission-audit.md). Invalid dispatch attempts remain invalid performance evidence.

The opening case uses 16 distinct buyers/units so pre-opening requests do not
occupy every bounded admission slot for the entire post-opening half. This changes
the additional boundary workload only; the five prescribed workloads are fixed.

For a host with a small ephemeral-port budget, explicitly cap a calibration run:
`STRESS_CONNECTIONS=1000 STRESS_MAX_CONNECTIONS=1000 pnpm test:stress stock100-10k duplicates stock100-100k stock10k-100k`.
The cap controls automatic socket-capacity retries only; dispatch still requires
**every** offered request write inside 1,000 ms. Invalid capped runs exit nonzero.
`preconnectMs` measures TCP setup; `readyWaitMs` separately records the wait for
Redis's target time. Earlier DEV-19 attempts recorded their sum as `preconnectMs`.

After a large socket attempt, allow the host's ephemeral ports/TIME_WAIT state to
recover before comparing replicas. For sufficient-stock replica calibration,
`STRESS_CONNECTIONS=100 STRESS_MAX_CONNECTIONS=100` avoids allocating thousands
of idle sockets; keep that setting identical across the replica comparisons.

## Readiness before dispatch

After initializing a new sale, setup explicitly checks every API and worker replica through its direct endpoint. A shared ten-second setup deadline bounds retries of unavailable or failed responses; HTTP success must include `status: ready`. Each endpoint, timestamp, HTTP status and returned readiness state/error is retained in `result.json` as `readinessAttempts`. Permanent failures remain invalid setup attempts with endpoint diagnostics. This wait places no purchases, changes no sale times and does not relax the one-second dispatch or boundary-straddle checks. PostgreSQL container health checks use authenticated TCP SQL so its temporary initialization server cannot prematurely satisfy application readiness.
