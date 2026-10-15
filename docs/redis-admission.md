# Atomic admission (DEV-9)

`admitPurchase(connection, saleId, input)` normalizes through the shared contracts and runs one Redis Lua script. Its `reserved` result is internal reservation evidence, **not** a durable acknowledgement. DEV-10 must confirm local AOF durability on the writing connection before acknowledging or persisting an order. Transport errors, unexpected replies and script errors throw `AdmissionUncertainError`; callers must keep these requests unresolved/PROCESSING and reconcile, never infer a rejection or use PostgreSQL inventory as a fallback.

The script owns these keys under `sale:{<UTF-8 sale ID in hex>}:admission` (one Redis Cluster hash slot):

| Key suffix | Type | Contents |
| --- | --- | --- |
| none | hash | `configuration_version=1`, `starts_at`, `ends_at` (epoch ms), `initial_stock`, `remaining_stock`; optional fault latch |
| `:identifiers` | hash | normalized identifier → original request key |
| `:requests` | hash | allocated request key → normalized identifier |
| `:reservations` | hash | request key → JSON `{identifier, admittedAtMs, streamId}` |
| `:stream` | stream | `sale_id`, `identifier`, `request_key`, `admitted_at_ms` |

Configuration is initialized only by the existing safe configuration script. Allocation keys are written only by admission; future worker/reconciliation code must preserve these associations. Keep Redis private, restrict credentials/key access to the application sale namespace, and do not grant untrusted clients Redis commands. Do not manually mutate, expire, trim, evict or delete admission keys. This prototype has trusted backend connections rather than separate provisioned Redis ACL users. Startup enforces AOF everysec and `noeviction`.

After validating key ownership, types, non-expiration, numeric configuration and allocation counts, admission checks allocated request replay/payload conflict, then allocated identifier, then the Redis TIME window (`start <= now < end`), then stock. Replay returns the original timestamp and stream ID even after closing or sellout. A new request for an allocated identifier returns `already_placed` with its original reservation. It creates no new allocation or request mapping.

Upcoming, ended, sold-out, duplicate and conflict rejections create no persistent per-request record. Their retries are reevaluated against current state; an upcoming rejection may later admit using the same key. Only **allocated** request keys retain stable replay outcomes. This bounds rejection storage under a burst and prevents a rejection from overwriting an allocation.

Accepted work decrements stock, records associations and appends a stream entry inside one script, with no client-side interleaving. `admittedAtMs` comes from Redis TIME; the stream ID is the authoritative execution-order sequence (including same-millisecond admissions). Neither represents client arrival or network order. Millisecond timestamps alone do not break ties.

Lua does not roll back. Predictable argument/type/configuration/stream-exhaustion errors are checked before writes. Immediately before mutation, the script sets `admission_fault` to the request key. A protected mutation block clears it only after all reservation writes succeed. An unexpected error leaves this persistent latch and any partial state intact; **all** admission, including replay, then fails closed pending operator reconciliation. Reconciliation must inspect stock, mappings, reservations and stream, restore their consistency and establish durability before clearing the latch. This ticket supplies fault evidence and blocking, not automatic repair. Resource exhaustion and process/storage failures still require DEV-10 durability/recovery handling; validation cannot make Redis transactional rollback available.

No reservation TTL, automatic release, retry exhaustion revocation or inventory fallback exists. Reservations and evidence persist for recovery.

Run `pnpm test:unit` for exact opening/closing timestamp predicates and wrapper validation, and `pnpm test:integration` for actual Redis Lua execution, two-connection contention, mixed-case duplicates, replay, schema errors, stream exhaustion and an injected partial-write failure. Test fixtures can seed timestamps directly; production has no clock override.

For admission alone, run `pnpm test:integration tests/integration/admission.test.ts`. The service runner forwards file filters to Vitest while preserving disposable-service isolation.
