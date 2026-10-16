# Flash-sale stress suite

Run `pnpm test:harness` for harness regression tests. Run `pnpm test:stress`
for all workloads, or supply scenario names to select cases. Docker must be running.
Each attempt uses a fresh isolated `flash-test-*` Compose project and sale; cleanup
removes only that project's test volumes.

## Required workloads

| Name | Stock | Requests | Unique buyers | Arrival window |
| --- | ---: | ---: | ---: | --- |
| `no-oversell` | 10 | 100 | 100 | synchronized release, writes within 1 second |
| `duplicates` | 10 | 100 | 10 | synchronized release, writes within 1 second |
| `sufficient-stock` | 1,000 | 1,000 | 1,000 | 1 second |
| `burst-10s` | 100 | 5,000 | 5,000 | 10 seconds |
| `burst-3s` | 100 | 5,000 | 5,000 | 3 seconds |
| `burst-1s` | 100 | 5,000 | 5,000 | 1 second |
| `spike-10k` | 100 | 10,000 | 10,000 | 1 second |

Duplicates use ten distinct request keys per buyer. `same-key-retries` repeats
one key per buyer to exercise idempotent retries separately. `healthy` checks
full allocation with eight buyers and eight units. Opening, closing, worker-crash,
closing-worker-crash and repeated-burst recovery experiments remain available.

The sufficient-stock burst measures saturation, allocation count, HTTP latency and committed-order visibility latency;
it does not require full allocation or assert the spike's latency SLO.

## Healthy spike acceptance

Under the recorded resource budget, `spike-10k` must dispatch every request within
one second, sell all 100 units, avoid overselling and duplicate orders, and preserve
every acknowledged reservation during this healthy test. Admission-to-durable-order p99 must be **under
2,000 ms**, and every admitted order must complete **within 10,000 ms**. Empty
admissions, missing timing observations or an observer failure cannot pass.
Recovery experiments do not use these healthy-operation deadlines.

The harness samples committed orders through an independent PostgreSQL connection
approximately every 25 ms during dispatch and drain. PostgreSQL `clock_timestamp()`
records first observed visibility on the database clock. This is a conservative
upper bound on commit latency including sampling/query delay; `completed_at` is
assigned before commit and is not used as proof of durability timing. Redis
admission timestamps and PostgreSQL clocks must be synchronized (the local Compose
services share the Docker VM clock). Observations and p50/p95/p99/max are retained
as `orderVisibility` in `result.json`. Observer load is part of this measurement.

## Dispatch and evidence

TCP sockets are preconnected before dispatch. Synchronized cases schedule every
request at zero; other cases spread offered work independently of responses over
90% of the declared window, leaving dispatch headroom. Every request write must
finish strictly before that window ends. This is an OS-write upper bound, not proof
of server receipt. Report actual dispatch spread for synchronized releases.

Invalid dispatch retries with increased sockets in fresh projects, retaining all
attempts. `STRESS_CONNECTIONS` and `STRESS_MAX_CONNECTIONS` control socket capacity.
`STRESS_API_REPLICAS` and `STRESS_WORKER_REPLICAS` accept 1–8. Defaults are one API
and one worker; resource limits and durability settings come from `compose.test.yaml`
and `compose.stress.yaml`. Each result retains resolved Compose configuration,
replica counts, host details, source snapshots, request timings/outcomes, HTTP
percentiles, service logs, resource samples and final Redis/PostgreSQL reconciliation.
Do not compare runs with different budgets as equivalent capacity results.

All cases require stock conservation, unique allocations/orders, matching mappings
and admission timestamps, completed admitted work and preservation of acknowledged
reservations during healthy operation. Drain reconciliation is bounded at 300 seconds; allowing this
diagnostic drain does not relax the spike's ten-second per-order deadline.
Readiness checks cover every API and worker before dispatch. Redis keeps AOF
everysec/noeviction and one asynchronous read-only replica; application operations
use neither WAITAOF nor WAIT. Healthy-run acknowledgement preservation is an
observed invariant, not a crash-safe admission guarantee. Transport/proxy errors and explicit
busy/sold-out outcomes remain separately reported; no new HTTP SLO is assumed.

Artifacts live under `test-results/stress/<project>/<scenario>/`. Use
`node scripts/stress/report.mjs <project-path>` to archive complete attempts.
The measurements in [DEV-19 results](../../docs/stress-results.md) describe the
previous barrier-based design and workloads and are historical evidence, not passes
of this revised suite or current acknowledgement contract. The former 100,000-request scenarios are no longer required.
