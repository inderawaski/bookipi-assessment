# Local recovery runbook

Contract: PROCESSING acknowledges primary-memory admission without waiting for disk or replication. A Redis crash/failover may lose that acknowledgement before PostgreSQL commit, even with volumes intact. SUCCESS reflects a committed PostgreSQL order. Never delete volumes as a recovery action.

## Safety rules

1. Keep admission unavailable while Redis restores or accounting is inconsistent.
2. Do not replenish stock by rerunning seed or subtracting only finalized orders.
3. Preserve pending reservations, queue entries and retry metadata.
4. Missing state during outage is not definitive rejection.
5. Replays use existing reservation identity and idempotent database writes; never create a second allocation.
6. Internal failures do not expire reservations or permanently fail valid orders.

## API outage or lost response

Restart API. Client looks up sale+normalized identifier. If the submission is still in memory, retry with its original key. A confirmed reservation or committed order is returned. An unresolved send outcome stays confirming until reconciled. No public attempt ID is required.

## Redis outage/restart

Stop/fence new admission. Restore from AOF on the existing volume. Verify configuration, persistence and key schema. Compare recovered reservations and queued work with committed PostgreSQL orders. Repair stale completed status and replayable unfinished work. Account for the union of allocations without double subtraction. Reopen only after invariant checks and fencing of pre-recovery commands succeed.

If configuration/accounting is inconsistent, or a committed PostgreSQL order has no matching Redis reservation, keep readiness closed. A consistent older Redis snapshot can legitimately lack an acknowledged but uncommitted reservation; polling then reports NOT_ORDERED and a same-key retry is allowed. A pending old command must not execute after a definitive rejection. Escalate to operator investigation rather than guessing inventory.

On startup and Redis epoch changes, each service readiness path fences admission and reconciles durable PostgreSQL orders against Redis reservations. Matching orders repair completion markers; missing stream entries are recreated atomically with retry/quarantine metadata transferred. This is the normal repair path, not a separate repair CLI. Restart services against the existing volumes:

```sh
docker compose stop api worker
docker compose up -d --wait postgres redis redis-replica
docker compose start api worker
docker compose logs --tail=200 api worker
curl -i http://localhost:8080/api/health/ready
node --env-file=.env scripts/recovery.mjs inspect flash-sale
docker compose exec redis redis-cli CONFIG GET appendonly appendfsync maxmemory-policy
docker compose exec redis redis-cli INFO persistence
docker compose exec postgres psql -U flash -d flash -c 'TABLE flash_sale;'
docker compose exec postgres psql -U flash -d flash -c 'TABLE "order";'
```

Use the configured database/user if changed from the example. Stop all API replicas to fence incoming requests operationally; stopping workers also prevents concurrent repair during inspection. Application epoch fencing still protects reconnects and unresolved old commands. Do not use CLIENT PAUSE as proof of absence.

Inspection prints `reconciliation` (stored recovery diagnostic), `retries` and `quarantine`. A null diagnostic alone is insufficient: all replicas must become ready, Redis persistence must be healthy, and allocation/order associations must reconcile. Unknown schema, expiring/wrong-type state, missing allocations or unexplained counts leave readiness closed. Inspect logs and retained data; there is no generic force-reopen command. If reconciliation cannot repair the inconsistency, preserve storage and investigate rather than hand-editing stock.

## Asynchronous replica

One read-only `redis-replica` follows the primary and has its own AOF volume. Check:

```sh
docker compose exec redis redis-cli INFO replication
docker compose exec redis-replica redis-cli INFO replication
docker compose exec redis-replica redis-cli INFO persistence
```

Expect one connected replica on the primary and master_link_status:up on the replica.
Replica outage does not block primary admissions. Do not read inventory/status from
the replica or treat it as proof that every acknowledged admission survived. There
is no automatic failover or endpoint switching. Promotion requires an explicit
operational plan to fence the old primary, select the new authority, update clients
and reconcile PostgreSQL before reopening; do not promote blindly. A primary
restart can resynchronize the replica to older state. Both volumes share one local
Docker host and provide no host-failure isolation.

## Final order capacity conflict

A worker that encounters PostgreSQL's final stock cap records the stream entry in
quarantine and sets admission_fault=committed_order_capacity. New admission remains
fenced. Inspect committed PostgreSQL orders, lost/surviving Redis reservations,
retry metadata and the quarantined entry. Do not clear the fault or replenish stock
without repairing the associations against committed orders. Existing matching DB
orders remain idempotent at full capacity; a conflicting new order does not commit.
The original in-flight commit/Redis-loss race and approved guard are documented in
[the final stock decision](admission-loss-crash-race.md).

## Worker outage

Restart worker. Reclaim idle pending messages after the documented threshold. Validate current reservation/stream associations before finalization; no persistence wait is used. Replayed committed orders are success; completion status/ack can safely repeat. A slow original worker and a reclaiming worker must still produce one order.

## PostgreSQL outage or unknown commit

Retain reservation and message; retry with backoff. After recovery check existing order under unique(sale,identifier). Lost commit response must not cause another allocation. PostgreSQL persistence configuration must honor durable commits.

## Retry exhaustion

Work becomes delayed recovery, still PROCESSING for the user. Inspect retry reason, original reservation and existing order. Replay through the normal idempotent path. Repeated replay is safe. Record remediation evidence; do not release stock to another buyer.

Build local packages once with `pnpm --filter './packages/**' build`; local scripts use the localhost URLs in `.env`, while Compose services use internal hostnames.

```sh
node --env-file=.env scripts/recovery.mjs inspect flash-sale
# Copy an actual exhausted stream ID from retries; this is only an example:
node --env-file=.env scripts/recovery.mjs replay flash-sale 1234567890000-0
node --env-file=.env scripts/recovery.mjs replay flash-sale 1234567890000-0
```

Replay atomically rearms exhausted work only after its recovery delay. Repeating while eligible/running has no effect; a later exhausted budget may be explicitly replayed again. Output “Replay requested” is not proof of completion: poll identifier status, inspect retry metadata and check the database. Lost replay command replies can be retried safely. Identity conflicts appear in the quarantine hash and require investigation.

Defaults: `ORDER_MAX_ATTEMPTS=5` (1–100), `ORDER_RETRY_BASE_MS=1000` (1–60000), `ORDER_RETRY_MAX_MS=60000` (1–3600000). Attempt n waits uniform jitter between half and all of min(cap, base × 2^(n−1)). A reserved attempt interrupted by a crash consumes budget and waits 60 seconds. Pending reclaim also uses a 60-second safety interval. Workers reconnect with 1–2 second loop backoff; each processes sequentially in read/claim batches of ten. Redis retry records retain attempts, nextAt, reason, exhausted and schema version. Neither exhaustion nor quarantine releases inventory.

## Readiness and completion checks

* Redis AOF enabled everysec, noeviction, expected schema/configuration.
* PostgreSQL reachable with constraints and migrations applied.
* Pending and finalized allocation accounting <= initial stock.
* At most one allocation/order per sale+identifier.
* All acknowledged admissions remain recoverable.
* No unresolved inconsistency or old command capable of invalidating a definitive rejection.

After service recovery, allow workers to drain and verify acknowledged reservations have one completed order. Record backlog/drain time. Test-only reset belongs to a separate disposable environment and is never a production/demo recovery procedure.
## Disposable test reset (destructive)

There is no demonstration reset command. `configure` is idempotent, not a replenishment tool. Integration/stress runners generate isolated `flash-test-UUID` projects and a `flash_test` database and delete only their own volumes. Failure runners remove containers but retain volumes and evidence under `test-results/failure/PROJECT/`.

Only after inspecting a completed disposable failure run, remove its exact two volumes with `docker volume rm PROJECT_postgres-test-data PROJECT_redis-test-data`, replacing PROJECT with that runner's printed project name. Verify `docker volume inspect` labels identify that isolated project first. Never target `flash-sale` volumes, use global prune, FLUSHALL, or truncate demonstration tables as recovery.

Human checkpoint C and G are pending. Record sale configuration, existing reservation identifiers, remaining stock and order count before/after restart or identical configuration retry. Confirm each reservation remains held and each acknowledged admission eventually has exactly one order. Automated evidence: [failure matrix](failure-matrix.md), [integration mapping](integration-coverage.md), [measured recovery](stress-results.md). Record backlog/drain time separately from readiness recovery.
