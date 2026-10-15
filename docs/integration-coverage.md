# DEV-16 / P00 integration coverage

Run `pnpm install --frozen-lockfile`, then `pnpm test:integration`. The runner builds workspace packages before loading tests and creates a unique Compose project with PostgreSQL 18.3-bookworm and Redis 7.4.8-alpine, persistent disposable volumes and unique host ports. Files run serially because restart tests operate on those services. Sale IDs are UUIDs; API instances, admission gates and workers belong to each test and close in finally blocks. No demonstration data is reset.

Run `pnpm test:browser` separately for Chromium UI evidence. Those tests stub HTTP responses; they complement the real-service suite rather than proving backend durability. `pnpm test:unit` remains the code tickets' pure-rule suite.

The P00 behavioral contract is DEV-5. It has no numbered requirement IDs, so the rows below name its requirements explicitly. Test names are executable Vitest/Playwright titles (parameterized titles use their template).

| P00 requirement | File and test name |
| --- | --- |
| Two tables, one unit, uniqueness, FK and immutable configuration | `sales.test.ts`: migrates and enforces order uniqueness, FK, ranges and immutable sale configuration |
| Partial initialization, repeated seed, zero stock and no stock replenishment | `sales.test.ts`: keeps partial initialization unavailable, resumes safely, and never reseeds reservations |
| Atomic reserve/mapping/stream append under contention | `admission.test.ts`: allocates the last unit once across independent connections and preserves fairness evidence |
| Generic trim/lowercase identity; deliberate new request reports duplicate | `admission.test.ts`: allocates mixed-case identifiers once, detects key conflicts and replays after closing; `api.test.ts`: exposes real admission, normalization, retries, delayed state and committed orders |
| Same-key repeat delivery appends once | `admission.test.ts`: collapses simultaneous delivery of one request into one reservation and stream append |
| First come means Redis execution order | `admission.test.ts`: records monotonic stream execution order in a concurrent admitted batch; `invariants.test.ts`: accounts independently for acknowledged admissions across two APIs and workers after closing and recovery |
| Inclusive opening / exclusive closing, exact predicate | `admission.test.ts`: evaluates exact opening and closing boundaries with the production Lua predicate (pure predicate evaluated without Redis TIME); `packages/contracts/src/sales/contracts.test.ts`: includes opening and excludes closing with Redis time (pure TypeScript rule owned by DEV-8) |
| Redis clock governs admission, API clock may differ | `invariants.test.ts`: accounts independently for acknowledged admissions across two APIs and workers after closing and recovery |
| Real-time upcoming/end and replay after closing | `api.test.ts`: replays an admitted result after closing and distinguishes upcoming and ended |
| Queued completion after closing | `invariants.test.ts`: accounts independently for acknowledged admissions across two APIs and workers after closing and recovery |
| Browser clock does not override server status | `purchase.spec.ts`: uses server sale status with browser clock offset ${offset} |
| Local AOF barrier before acknowledgement/worker persistence, uncertainty retained | `durability.test.ts`: fences unreconciled sales, confirms replay/duplicates/lookup, and gates worker evidence; confirms a different connection reservation by advancing its own AOF prefix; never treats missing lookup as rejection, including a delayed admission executing afterward |
| Stream group ACK and idempotent durable processing | `orders.test.ts`: persists once across concurrent deliveries, repeats completion/ack and quarantines conflicts |
| Independent allocation <= stock, unique allocation/order, every acknowledged admission finalized | `invariants.test.ts`: accounts independently for acknowledged admissions across two APIs and workers after closing and recovery |
| API/worker scale independently; bounded overload before admission | `overload.test.ts`: shares last stock and duplicate mappings across independently bounded API instances; rejects an exhausted durability pool before send and recovers without losing admitted work; times out an exhausted database pool before admission without allocating |
| Unknown sale, remaining inventory, API lookup/polling | `invariants.test.ts`: accounts independently for acknowledged admissions across two APIs and workers after closing and recovery; `api.test.ts`: exposes real admission, normalization, retries, delayed state and committed orders |
| Reservations retained through retry exhaustion/replay/worker restart | `recovery.test.ts`: exhausts during database outage and resumes once after repeated replay and worker restart |
| Reconciliation restores missing work/completion without replenishment | `recovery.test.ts`: retains exhausted allocation, replays once, repairs missing work and completion, and fences unknown schema |
| Persistent volumes survive actual service restart | `restart.test.ts`: retains PostgreSQL and AOF markers across a restart without deleting volumes |
| UI duplicate/error/status/refresh behavior | `purchase.spec.ts`: new placement reports already placed and preserves success through rejection; refresh retrieves remembered pending and successful orders after sale ends; uncertain delivery retries the same key and recovers to success |

The invariant scenario compares raw Redis identifier mappings, retained stream entries, acknowledged normalized identifiers and PostgreSQL rows independently. It checks uniqueness, stock conservation, stream sequence and admission timestamps, a sequentially acknowledged prefix before contention, and a drained pending list. HTTP response completion order is never used as fairness evidence. Concurrent losers have no admission sequence, so this does not claim a total order of rejected HTTP requests.

Eventual checks are read-only, bounded `expect.poll` calls. Drain failures print expected/actual identifier sets, pending count and worker errors. Boundary polling reads Redis TIME; there are no unconditional boundary sleeps. Closing has a 15-second wait budget, drain a 30-second budget (two everysec AOF barriers per order) and the complete invariant scenario a 60-second ceiling. Fixtures use a future opening and real closing; no production clock hook or admission-script substitution is needed for this scenario.

Deterministic crash/network boundary proof is DEV-17, one-second stress dispatch and measured capacity are DEV-18/19, and final human walkthroughs are DEV-22. Existing failure tests are supplemental; this matrix does not claim those later tickets or the full P00 assessment are complete. API instances and workers here run in the test process with real independent durability/consumer connections; process-crash evidence belongs to the failure suite.
