# Public sale contract (DEV-8 / checkpoint A)

Shared types, JSON Schemas and state rules live in `@flash/contracts`; the API implements these routes. The user-approved uncertainty revision below supersedes the original requirement that all unconfirmed public outcomes use PROCESSING. The 16 October 2026 immediate-acknowledgement decision additionally supersedes the prior disk-confirmed PROCESSING guarantee. Historical checkpoint records are unchanged.

## Routes and envelopes

External paths have the proxy prefix `/api`; Fastify routes omit it.

| Method / route | Input | Response |
| --- | --- | --- |
| GET /sales/:saleId | saleParamsSchema | saleResponseSchema |
| POST /sales/:saleId/purchases | saleParamsSchema + purchaseBodySchema | purchaseResponseSchema |
| GET /sales/:saleId/order?identifier=... | saleParamsSchema + lookupQuerySchema | lookupResponseSchema |

POST body: `{"identifier":" Alice@Example. ","idempotencyKey":"client-generated-key"}`. No attempt ID, quantity, username/email syntax, authentication or payment. Client creates a random key once per logical submission, keeps it in memory and reuses it after timeout/retry. Refresh loses the key: first look up the identifier. URL-encode sale IDs and query identifiers.

Schemas reject unknown fields and wrong types. Route implementation must disable Ajv coercion and additional-property removal and run normalization after structural validation. JSON Schema length limits are only coarse bounds; the shared normalizer enforces normalized UTF-8 byte length.

Sale example: `{"saleId":"sale","startsAt":"2026-10-15T00:00:00Z","endsAt":"2026-10-16T00:00:00Z","observedAt":"2026-10-15T12:00:00Z","status":"OPEN","remainingStock":100}`. Stock is observational, not a promise. Window status has precedence: upcoming before start, ended at/after end, otherwise sold out if zero, otherwise open. Only Redis TIME decides admission: **start <= now < end**. Frontend countdown and API time are informational. The window limits admission, not confirmation or persistence.

## Submission and lookup examples

| Situation | HTTP | Body |
| --- | --- | --- |
| Admission may have executed; Redis command outcome unresolved | 202 | `{"status":"NOT_ORDERED","reason":"confirmation_uncertain"}` |
| Redis primary acknowledged reservation, awaiting worker | 202 | `{"status":"PROCESSING","phase":"queued"}` |
| Retry/recovery/manual remediation needed | 202 | `{"status":"PROCESSING","phase":"delayed"}` |
| Persisted order (GET lookup) | 200 | `{"status":"AVAILABLE","order":{"status":"SUCCESS","orderId":"order-1"}}` |
| New key, existing allocation | 409 | `{"status":"REJECTED","reason":"already_placed","existingOrder":{"status":"PROCESSING","phase":"queued"}}` |
| Before/after window, no stock | 409 | `{"status":"REJECTED","reason":"upcoming"}` (or `ended`, `sold_out`) |
| Changed normalized payload for bound key | 409 | `{"status":"REJECTED","reason":"idempotency_conflict"}` |
| Invalid payload/identity/key | 400 | `{"status":"REJECTED","reason":"invalid_input"}` |
| Definite pre-admission capacity rejection | 429 | `{"status":"REJECTED","reason":"busy"}` |
| Definite pre-admission dependency failure | 503 | `{"status":"REJECTED","reason":"unavailable"}` |
| Unknown sale | 404 | `{"status":"REJECTED","reason":"not_found"}` |

No creation claim is made for duplicates or replays. Same sale/key + same normalized identifier returns or reconciles its original outcome (including rejection); changed identifier conflicts. Keys are opaque and case-sensitive, scoped by normalized sale ID, and bound atomically to payload/outcome. They are retained without TTL but may be lost with Redis state before persistence/replication. Pre-admission busy/unavailable is not a bound admission outcome and may be retried with the same key. Key checks precede identifier duplicate and time/stock checks. New key + allocated identifier reports `already_placed` with acknowledged PROCESSING status. POST does not read PostgreSQL order status after Redis acknowledgement; use GET lookup for SUCCESS.

Lookup returns HTTP 200 `{"status":"AVAILABLE","order":{"status":"NOT_ORDERED"}}` when PostgreSQL has no order and successful readiness plus Redis lookup observes no reservation. This means no placement is currently confirmed, not proof that an older purchase cannot execute later. A known reservation whose current state cannot be validated returns `NOT_ORDERED` with `reason: "confirmation_uncertain"`. Validated current reservations return PROCESSING and committed orders return SUCCESS. Failed database/readiness reads return HTTP 503 UNAVAILABLE; an existing PostgreSQL order remains readable without Redis. Input/unknown-sale errors use 400/404 REJECTED. Sale dependency outages use 503 UNAVAILABLE.

An unconfirmed purchase returns HTTP 202 `{"status":"NOT_ORDERED","reason":"confirmation_uncertain"}`. It is neither a durable acknowledgement nor a definitive admission rejection. An already-placed response may carry this same state in `existingOrder` until confirmation succeeds. Redis library states remain internal PROCESSING/confirming; workers validate the current reservation/mappings before committing, without WAITAOF or WAIT.

A Redis acknowledgement returns PROCESSING immediately; it is **not** confirmation
of disk persistence, replica receipt or final order creation. AOF everysec and one
asynchronous read-only replica run in the background. Acknowledged admissions can
be lost in a crash/failover before PostgreSQL commit. This is an accepted trade-off.
Workers and retry/recovery metadata do not await persistence or replica barriers.

A timeout after possible execution remains uncertain, not ordinary busy/unavailable.
Keep the same key and allow retry, including after closing/sellout to resolve an
existing attempt. Continue polling. Keep the in-memory key through PROCESSING until
SUCCESS or an appropriate definitive pre-admission result. A fresh successful empty
lookup can clear PROCESSING and show a lost-reservation retry message; an unavailable
or uncertain lookup cannot. Refresh loses the key; current identifier uniqueness
still prevents duplicate allocation while the Redis state survives. If the original
admission/key was lost, retry is subject to current stock/window rules.

PostgreSQL SUCCESS is final. Worker/database failures retain surviving reservations
and use delayed retries; they do not deliberately release stock. Redis data loss
can clear a provisional acknowledgement. A committed PostgreSQL order whose Redis
metadata is missing remains readable as SUCCESS, while admission readiness stays
fenced for operator reconciliation to prevent overselling.

## Identity and operational bounds

Canonical identity is ECMAScript `trim().toLowerCase()` everywhere, including configuration, submission, lookup and persistence. Lowercasing is locale-independent Unicode lowercase, not full Unicode case folding. No NFC/NFKC normalization: `É` and `E` + combining acute remain different, as do `ß` and `SS`. `İ` expands to `i` + combining dot; final sigma follows JavaScript lowercase rules. `@`, `.`, spaces within identifiers and other Unicode characters are ordinary. Empty after trim is invalid. NUL is excluded because PostgreSQL text cannot store it.

Shared limits: 16,384-byte JSON body; 8,192-byte encoded request target; normalized identifiers and sale IDs at most 1,024 UTF-8 bytes; opaque key 1–128 printable ASCII bytes excluding spaces. These bound infrastructure/storage, not business identity. Body overflow is HTTP 413; request target overflow is HTTP 414 (proxy may return its native error body). DEV-13 must enforce the shared target cap; existing proxy/API body caps are 16 KiB. Validation and normalization occur before Redis. Reject oversize input without logging identifiers. No truncation.

## Final committed-order stock guard

All application final order transactions lock the sale row at READ COMMITTED and
cap committed orders at initial_stock. Matching existing orders replay successfully
at capacity. This does not delay Redis acknowledgement or add a database reservation
transaction to the admission path. If Redis state loss permits a conflicting new
reservation while an older transaction commits, the new work is quarantined and
admission is fenced for operator reconciliation. It cannot create an extra committed
order. See [the approved guard](admission-loss-crash-race.md).

## Client stale-response rule

Keep order state separately from the latest submission outcome. `reconcileOrder` preserves SUCCESS against delayed PROCESSING/NOT_ORDERED/rejection, and PROCESSING against uncertain lookup or a new rejected placement. A fresh matching-generation successful empty lookup may clear PROCESSING after reservation loss. `already_placed` reconciles its nested existing order. Lookup UNAVAILABLE retains the last known state with a separate connectivity indicator. Queued/delayed states also resist a stale confirming phase. Phase changes between queued and delayed remain informational.

Every request must capture normalized sale/identifier and a local increasing request generation. Ignore responses for a different active identity or older generation; clear displayed state on identity change. Apply reconciliation only to matching identity. A rejection must remain visible as the latest attempt outcome without displaying an existing order as failed. Tests exercise schema boundaries, Unicode, idempotency, HTTP classification, time boundaries and provisional reservation loss. Real Redis atomicity and outage behavior remain integration work in dependent issues.

## Live API (DEV-13)

The routes above are now registered by the API service. Strict structural validation precedes normalization and dependency access. Lookup checks PostgreSQL first: a committed order remains readable when Redis is unavailable. An empty observation requires a successful database read, readiness/reconciliation, and Redis lookup showing no allocation. These checks do not exclude delayed commands. Failed current-state validation with an established identifier mapping is `NOT_ORDERED/confirmation_uncertain`; failed reads otherwise return unavailable. Retry or quarantine metadata yields `PROCESSING/delayed`, and never a failed order. Completion hints in Redis cannot produce `SUCCESS`.

Set optional `WEB_ORIGIN` to an exact HTTP(S) origin (no trailing slash) for a separately hosted frontend. Same-origin proxy requests need no CORS setting. Only that origin receives CORS headers; preflight permits GET/POST with Content-Type. Automatic request logging is disabled to keep identifiers in request targets out of logs, and errors use fixed public envelopes without raw input. The API enforces the 8 KiB request target and 16 KiB body limits.

The proxy logs only method, status, and elapsed time. Per-server request error logging is disabled because Nginx includes raw URLs in those messages; process/startup errors retain the global error log. Proxy request-line buffers also bound oversized targets.
