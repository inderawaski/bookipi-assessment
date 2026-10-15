# Retry and recovery operations

Workers reserve a durable attempt before processing. `ORDER_MAX_ATTEMPTS` defaults to 5
(range 1–100). `ORDER_RETRY_BASE_MS` defaults to 1000 (1–60000), and
`ORDER_RETRY_MAX_MS` defaults to 60000 (1–3600000). For attempt n, the delay is
uniform jitter between half and all of min(max interval, base interval × 2^(n−1)).
An interrupted attempt has a 60-second recovery delay, above the bounded database
and durability operation deadlines. Even a crash before processing consumes an attempt.
Redis Streams retain pending messages; reservations and stock are never released.
Exhaustion means PROCESSING/delayed, requiring operator replay after remediation.
Retry records retain attempts, nextAt, reason, exhausted, and schema version.

Build packages first (`pnpm --filter './packages/**' build`), then use:

```sh
node --env-file=.env scripts/recovery.mjs inspect SALE
node --env-file=.env scripts/recovery.mjs replay SALE STREAM_ID
```

Inspection intentionally prints internal stream keys and reasons for the operator.
Service recovery logs omit customer identifiers and request keys. Replay atomically
rearms only exhausted work whose recovery delay has elapsed. Repeating the command
while work is eligible/running has no effect; a later, newly exhausted budget can be
explicitly replayed again. Quarantined identity conflicts require investigation,
not automatic replay. If a durability reply is lost, repeating replay is safe.
A Redis outage does not reset budgets; workers reconnect with a 1–2 second loop backoff.

On process startup and Redis epoch changes, readiness reconciles the complete durable
order snapshot against retained reservations. Admission is fenced before validation.
Matching orders repair completion markers without decrementing stock. Reservations
missing stream entries receive new entries atomically with updated reservation pointers
and transferred retry/quarantine metadata. Rerunning after interruption is safe.
Unexplained counts, missing order allocations, conflicting timestamps, unknown schema,
expiring state, wrong key types, and inconsistent associations keep admission fenced.
Inspect PostgreSQL orders, Redis configuration, mappings, reservations, stream, and
retry metadata; preserve storage and diagnose the mismatch before repair. Never
increment stock to work around delayed orders. Recovery scans are startup operations,
not admission-path work; large sales can delay readiness while the atomic scan runs.

`configure` is idempotent and rejects conflicting configuration. There is no production
reset command. The service test runner generates an isolated `flash-test-UUID` project
and a `flash_test` database. Integration runs remove their disposable volumes; failure
runs retain volumes and evidence for inspection. See [the failure matrix](failure-matrix.md).

Human checkpoint C (requires a person; not recorded as completed): configure a sale,
reserve one unit, stop the worker, restart it and confirm exactly one order. Repeat
with PostgreSQL unavailable until the finite attempt budget exhausts; inspect the
reason/count, restore PostgreSQL, replay twice and confirm one order and unchanged
remaining stock. Run `pnpm test:integration` and `pnpm test:failure` for automated evidence.
