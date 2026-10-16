# Sale configuration reads through Redis

Implemented on 17 October 2026 after checkpoint ca86e91. This change also commits
the previously completed Redis-only purchase route and its preserved evidence.

## Read flow

```text
POST purchase:
    validate input
    Redis admission Lua checks preloaded configuration and reserves stock
    no PostgreSQL configuration lookup or readiness probe

GET sale / GET uncommitted order:
    read immutable configuration already preloaded in the Redis admission hash
    if absent:
        read Redis metadata snapshot
        if snapshot is missing/invalidated or does not contain requested sale:
            load PostgreSQL configuration and cache the snapshot
    continue existing status / reservation checks

startup / health readiness (API and worker):
    check database and Redis availability
    read sale discovery/metadata snapshot from Redis
    load PostgreSQL configuration only on snapshot miss/invalidation
    validate live admission state; reconcile committed orders when required

GET committed order:
    query PostgreSQL order first
    return SUCCESS without requiring Redis configuration
```

## Safety and lifecycle

The metadata snapshot is scoped by database name and stored without TTL. Sale
configuration is immutable. The snapshot is distinct from live stock and
reservations; loading it cannot create inventory, reset remaining stock or clear
an admission fence. A cache miss after opening therefore never reconstructs
missing admission state. Corrupt cached fields and Redis failures fail closed.

Successful admission configuration increments a global revision atomically.
Snapshots also record the Redis primary run ID, so a restart invalidates a
persisted snapshot. A cold reader publishes its database snapshot only if the
run/revision token has not changed while it was loading; otherwise it retries up
to three times. This prevents concurrent configuration from being hidden by an
older late cache fill. Simultaneous cold misses may duplicate DB reads; no
additional distributed lock or background refresh is introduced.

Readiness still queries PostgreSQL for health, and recovery still reads committed
orders. Order lookups and final order transactions also retain their database
access. The change removes repeated sale-configuration reads, not every database
operation. GET for an unknown ID falls back to PostgreSQL before returning 404.
The cache/revision scripts target the deployed single Redis primary, not Cluster.

## Verification

Unit and real service coverage checks Redis cache hits without DB fallback,
reuse of fields preloaded for Lua, miss loading, configuration invalidation,
concurrent publication rejection, corrupt metadata, an actual Redis restart,
and cache filling without recreating admission stock. Existing database-outage,
stock-cap, duplicate, time-window, restart-fence and crash coverage remains.

No new stress benchmark is claimed for this cache change. Earlier Redis-only POST
[spike results](redis-only-admission-results.md) remain historical evidence rather
than measurements of this revision.

Checks passed: **71 unit tests, 51 integration tests, 22 crash/network tests**,
typecheck, lint and build. Review covered cache miss/hit behavior, concurrent
configuration invalidation, restart epoch handling, corruption, absence of stock
mutation and committed-order reads without Redis. Verification logs and measured
source files are retained in the [manifest](evidence/sale-configuration-cache/manifest.json).
