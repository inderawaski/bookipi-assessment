# One-second burst measurements (DEV-18)

Run `pnpm test:harness` for accounting and real TCP timing tests. Run
`pnpm test:stress stock100-1k` for the smallest full pipeline check, or
`pnpm test:stress` for all seven cases. Docker must be running. Each case creates
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
Execution and scaling experiments belong to DEV-19.

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

Queue drain starts after burst responses finish and is bounded at 120 seconds.
Reconciliation reads PostgreSQL and Redis directly. No purchase POSTs are issued
after the scheduled burst. Readiness probes and metrics GETs run outside the burst.
Redis uses the same AOF everysec/noeviction configuration and application WAITAOF
barriers as production; the harness asserts these settings before starting.
