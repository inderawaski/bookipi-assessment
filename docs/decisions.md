# Architecture decisions and trade-offs

Integrated from the [authored draft](https://linear.app/bookipi-assessment/document/decisionsmd-repository-ready-draft-b5546cf13d28), with implementation details and measured limitations added for DEV-20.

## Scope

The original assessment is the required scope. High throughput/scalability, fault tolerance and concurrency correctness are mandatory and require evidence. Code clarity does not justify omitting them. The two-day implementation budget assumes AI-assisted coding; performance must still be measured.

| Decision | Rationale | Cost/limit |
| -- | -- | -- |
| TypeScript and Fastify | Focused API with explicit contracts and testable boundaries | Framework alone does not establish throughput |
| React single page | Matches required UI and actively retrieves status | Polling adds traffic and needs backoff |
| Generic normalized identifier | Matches brief without building auth | Anyone can enter another identifier; cannot enforce one human |
| Two tables, implicit product, unit orders | Strictly one product and one unit per user | Future product/auth features need schema changes |
| Redis Lua admission | Atomic stock/identity/window checks and reservation/enqueue | Serialized single-sale authority; script errors are not rollback |
| Redis Streams consumer groups | Queue append inside admission script; pending recovery | At-least-once processing requires idempotent workers |
| Reserve at admission | First admitted buyer keeps allocation despite stalled worker | Exhausted/delayed work consumes inventory until repaired |
| Redis time, start inclusive/end exclusive | One authoritative boundary across API replicas | Assumes synchronized wall clock |
| Admission window, not completion window | Accepted users remain eligible after closing | Queue may drain after sale ends |
| Primary acknowledgement, AOF everysec and one asynchronous replica | Low-latency PROCESSING without WAITAOF/WAIT | Acknowledged admission may be lost before PostgreSQL commit; no automatic failover |
| PostgreSQL final order uniqueness plus per-sale stock cap | Defensive replay and no excess committed orders across Redis loss/in-flight commit races | Final writes lock the sale row and serialize per sale |
| Independent API and worker scaling | Burst handling separate from processing rate | Redis admission limit remains |
| Bounded pre-admission overload rejection | Protects system and acknowledged work | Some eligible offered traffic may receive retryable busy |
| Delayed recovery rather than permanent failure | No business reason to revoke admitted allocation | Requires operator visibility and replay |
| In-memory request key | Prevents accidental duplicates within submission | Does not survive refresh; identifier lookup handles recovery |
| No public attempt ID | One possible allocation per sale+identifier | Definitive absence still needs careful fencing |
| Immutable configured sale | Avoids new business rules for live edits | Changes require a separate pre-sale configuration |

## Alternative: database-only reservation

A PostgreSQL design can reserve stock and enforce user uniqueness in a short transaction, then process asynchronously. It does not inherently wait for previously admitted orders to finish. Redis is selected to isolate admission load from order persistence and provide fast early sold-out decisions. Performance superiority is a hypothesis to validate, not a universal claim at 10k stock or 100k attempts.

## Business failure exclusions

V1 has no payment, fraud, shipping eligibility, external inventory or other post-admission rejection dependencies. Worker/database faults delay surviving reservations. Redis crashes/failover may lose an acknowledged reservation before PostgreSQL commit; this is an accepted trade-off. Immediate admission rejection remains possible for invalid identity, window, stock or duplicate rules.

## Future schema changes

Authentication would introduce user and replace the free-form order identity with an appropriate user foreign key, including an explicit migration/identity policy. Multiple products would introduce product and explicit product/sale/order relationships according to the expanded domain. Neither is implemented in V1.

## Revised acknowledgement decision (16 October 2026)

The user explicitly chose immediate Redis acknowledgement over admission durability
waits. The previous WAITAOF contract and its historical measurements are superseded.
PROCESSING now means the primary accepted the reservation; SUCCESS means PostgreSQL
committed the order. AOF everysec and one read-only asynchronous replica provide
background persistence/copying without delaying acknowledgements. No WAIT, WAITAOF,
Sentinel or automatic failover is used. Current frontend polling can clear a lost
PROCESSING reservation; it never clears SUCCESS or treats an unavailable read as
absence. Primary/replica volumes on one Docker host do not provide host redundancy.

[Architecture](architecture.md) and [public contract](public-contract.md) define
current semantics. [Scale-out measurements](scale-out-results.md) used the previous
barrier-based design and are historical evidence; no performance improvement is
assumed until the new design is measured. The user additionally approved the [final PostgreSQL stock guard](admission-loss-crash-race.md)
after the crash-race regression. Concurrency limits remain configurable and unchanged. Replica count is one; API/worker replication is independent.

## Final stock-cap trade-off (user approved, 16 October 2026)

Removing Redis durability waits allows an acknowledged reservation to disappear
while its worker already has a PostgreSQL transaction in flight. Recovery can
observe no committed order, reopen that unit and admit another buyer before the
old transaction commits. The original regression produced two orders for one unit.
Redis epoch fencing and per-buyer uniqueness alone do not close this race.

The approved defensive guard locks the existing flash_sale row at READ COMMITTED
inside every application order transaction. A matching existing order replays
successfully at full capacity. A new order is inserted only while committed count
is below initial_stock, with the lock held through commit/rollback. This adds no
schema/table and no PostgreSQL operation to the Redis acknowledgement path.

The benefit is a final committed-order cap despite Redis admission loss. The cost
is **serialization of final writes per sale**, additional lookup/count queries and
possible lock waits/timeouts. Adding workers can improve other processing stages,
but cannot make same-sale final transactions execute concurrently through this
critical section. The count query also does more work as a sale's order population
grows; the measured 100-stock spike does not establish capacity for larger sales.
Different sales lock different rows.

A conflicting replacement reservation is quarantined and fences new admissions
for operator reconciliation. This favors no overselling over continued availability
and fulfillment of every provisional acknowledgement after data loss. No stock is
silently released. Immediate Redis acknowledgement and its accepted loss risk remain;
one asynchronous replica provides neither synchronous durability nor automatic failover.

[The reproduced race and approved design](admission-loss-crash-race.md) and
[final verification](final-stock-cap-results.md) retain the evidence. The final
10,000-buyer spike used **one API / one worker / one Redis replica** and measured
approximately 544-ms order p99. Two subsequent 3/1 attempts with the final guard filled 100 units and met order
latency targets (p99 1.88 and 1.07 seconds), with fewer purchase 504s (673 and 833).
Both overall runs remain measurement_failed because the final proxy metrics request
returned no live upstreams, despite successful direct metrics reads from all three
APIs. See the [follow-up](final-stock-cap-results.md#requested-3-api--1-worker-follow-up).
The earlier WAITAOF scale-out matrix remains separate historical evidence.

## Historical durability and scaling boundary (superseded)

Acknowledged admissions survive local service/container crashes with persistent storage intact. Volume loss, disk corruption, host/region redundancy and geographically distributed fairness are excluded. At larger scale, partitioned stock or edge admission may help but changes ordering/consistency trade-offs. Document actual measured limits and a credible future design without pretending V1 implements it.

## Pinned implementation

Pins come from [Dockerfile](../Dockerfile), [Compose](../compose.yaml), workspace package manifests and pnpm-lock.yaml; these are reproducible project selections, not claims about latest releases.

| Component | Pin |
| --- | --- |
| Node / pnpm | 22.23.2 / 11.25.0 |
| TypeScript / Fastify | 5.9.3 / 5.12.7 |
| React and React DOM / Vite | 19.3.1 / 8.3.4 |
| Redis server / node-redis | 7.4.8-alpine / 6.3.0 |
| PostgreSQL / pg | 18.3-bookworm / 8.23.1 |
| Nginx | 1.28.2-alpine |
| Vitest / Playwright | 5.0.4 / 1.64.1 |

## Bounded defaults and their costs

Each API allows 64 concurrent HTTP handlers; each API/worker durability gate allows 16 independent operation sockets with a 3,000 ms deadline and no waiting queue. Batch size is one. Pre-admission overload returns busy (HTTP 429, Retry-After: 1); possible sends remain uncertain. PostgreSQL pools have ten connections per process and 2,000 ms acquisition/query bounds. Redis offline queues are disabled and command queues capped at 256. More replicas multiply both connection budgets and offered load on shared storage; horizontal scaling does not remove that shared limit.

Workers read/claim ten entries at a time but process sequentially. Abandoned work is reclaimable after 60 seconds. The durable attempt budget is five, including interrupted attempts; exponential jitter is half to all of min(60,000 ms, 1,000 ms × 2^(attempt−1)). An interrupted attempt has a 60-second recovery delay. Dependency-loop failures back off 1–2 seconds. Exhaustion retains the allocation as delayed; operator replay rearms an exhausted eligible budget after remediation. Identity conflicts are quarantined for investigation. See [retry implementation](../packages/redis/src/sales/retries.ts) and [operator commands](recovery.md).

The frontend starts identifier lookup after 300 ms and polls at 1, 2, 4, 8, 16 then 30 seconds, stopping on SUCCESS. Sale refresh is five seconds, or 30 seconds after ended/sold out; countdown updates each second. Fetch timeout is eight seconds. Polling continues for pending work after closing. These choices bound polling frequency while allowing recovery after a lost response; they add read traffic and may delay visible completion.

Compose gives each API, worker, Redis and PostgreSQL one CPU / 512 MiB; proxy and static web each get 0.5 CPU / 64 MiB. Nginx has two-second upstream connect and five-second upstream read/body/header/send inactivity bounds, with purchase retries disabled. Full configuration and metrics semantics are in [operations](operations.md).

## Protocol choices made concrete

The [architecture](architecture.md) specifies the exact keys and code references. Redis 7.4.8 confirmation validates a reservation then writes a checkpoint and performs WAITAOF on that same operation's socket. Replay and lookup cannot bypass the barrier. A local count of one is required; no replica quorum is claimed. AOF everysec still introduces fsync cadence and confirmation latency. One socket per operation favors a small, inspectable protocol over batching efficiency.

Recovery uses the Redis run_id fence, shared across replicas, with per-process readiness caches rather than leader election. Atomic reconciliation validates retained stock/mappings and the complete DB snapshot, recreates missing stream entries from valid reservations, transfers retry/quarantine pointers and repairs completion hints. It never releases allocations or resets stock from completed-order counts. Invalid state stays fenced. Concurrent readiness reconciliation may temporarily reduce availability; scans cost time proportional to retained evidence and block Redis while Lua runs.

The durability library keeps missing identifiers confirming because recovery fencing does not exclude delayed commands. The user-approved public revision defines NOT_ORDERED as placement not currently confirmed, with `confirmation_uncertain` on unconfirmed submissions/known reservations. The UI retains the key, continues polling and re-enables Buy Now with a retry message; empty lookup cannot erase confirmed progress. This trades definitive negative semantics for actionable retry without inventing a second admission store. See [architecture](architecture.md#public-uncertainty-semantics-user-approved-revision). Durable rejection still binds one request key; workers and durability guarantees are unchanged.

## Historical measured limits, not current performance promises

[DEV-19 results](stress-results.md) and their raw artifacts are the measurement authority. On the shared Apple M4 Pro / 24 GiB host with Docker's roughly 7.748 GiB VM, three of five prescribed workloads have valid one-second dispatch and passing invariants. Both 100,000-request workloads remain dispatch-invalid; checkpoint F is pending. This prototype has not demonstrated the full assessment burst target.

A valid sufficient-stock 1,000-request case admitted 16 units and rejected 984 as busy; response p50/p95/p99 were 7.69 / 140.03 / 2,183.10 ms, with 30.77 seconds of drain after responses. These response percentiles are dominated by busy outcomes, not order completion latency. Default admission slots, roughly one-second barrier cadence and serial worker processing constrain that case; low Redis CPU and zero sampled DB pool wait do not establish disk saturation or a DB capacity ceiling.

In the controlled replica comparison, 1 API / 1 worker admitted 16 and drained in 30.96 seconds, 3 / 1 admitted 48 and drained in 96.30 seconds, and 3 / 3 admitted 47 and drained in 40.96 seconds. Extra APIs increased backlog; workers improved drain by 2.35× for nearly equal allocations. This is not linear-scaling evidence. Stress measurements used an explicitly larger proxy budget (one CPU / 512 MiB) after the demonstration proxy was OOM killed. Invalid runs and transport/proxy failures remain in the report.

A credible next experiment uses dedicated generator/server hosts, sizes gate budgets from latency evidence, and evaluates batching with renewed crash/fairness tests. Partitioning by sale can distribute independent sales; splitting one sale's stock would require an explicit global ordering and duplicate-identity policy. Replication/failover needs a stronger durability protocol than this local barrier. Authentication and product schema migrations remain future scope, with no tables or behavior added here.
