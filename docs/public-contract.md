# Public sale contract (DEV-8 / checkpoint A)

These are shared types, JSON Schemas and pure state rules in `@flash/contracts`, not live endpoints. DEV-13 implements transport and DEV-9/10 implement atomic admission and durability. Checkpoint A is **pending human review** of these examples before admission implementation; no approval is implied by this commit.

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
| Admission may have executed; durability/outcome unresolved | 202 | `{"status":"PROCESSING","phase":"confirming"}` |
| Reserved and local AOF durability established, awaiting worker | 202 | `{"status":"PROCESSING","phase":"queued"}` |
| Retry/recovery/manual remediation needed | 202 | `{"status":"PROCESSING","phase":"delayed"}` |
| Persisted order | 200 | `{"status":"SUCCESS","orderId":"order-1"}` |
| New key, existing allocation | 409 | `{"status":"REJECTED","reason":"already_placed","existingOrder":{"status":"SUCCESS","orderId":"order-1"}}` |
| Before/after window, no stock | 409 | `{"status":"REJECTED","reason":"upcoming"}` (or `ended`, `sold_out`) |
| Changed normalized payload for bound key | 409 | `{"status":"REJECTED","reason":"idempotency_conflict"}` |
| Invalid payload/identity/key | 400 | `{"status":"REJECTED","reason":"invalid_input"}` |
| Definite pre-admission capacity rejection | 429 | `{"status":"REJECTED","reason":"busy"}` |
| Definite pre-admission dependency failure | 503 | `{"status":"REJECTED","reason":"unavailable"}` |
| Unknown sale | 404 | `{"status":"REJECTED","reason":"not_found"}` |

No creation claim is made for duplicates or replays. Same sale/key + same normalized identifier returns or reconciles its original outcome (including rejection); changed identifier conflicts. Keys are opaque and case-sensitive, scoped by normalized sale ID, bound atomically to payload/outcome and retained for the sale's lifetime, including recovery/replay. Pre-admission busy/unavailable is not a bound admission outcome and may be retried with the same key. Key checks precede identifier duplicate and time/stock checks. New key + allocated identifier reports `already_placed` with existing processing/success status.

Lookup returns HTTP 200 `{"status":"AVAILABLE","order":{"status":"NOT_ORDERED"}}` only when authoritative sources establish absence. It returns PROCESSING or SUCCESS inside `order` when established. During outages, an established durable order may still return SUCCESS; otherwise use HTTP 503 `{"status":"UNAVAILABLE","reason":"unavailable"}`. Never infer absence from a failed read or Redis absence while durable/recovery state is unresolved. Lookup invalid input/unknown sale uses 400/404 REJECTED as above. Sale dependency outages also use 503 UNAVAILABLE.

A timeout after possible execution is **never** ordinary busy/unavailable rejection. Keep the key and reconcile; no new logical placement or released stock. Internal progression is unresolved → reserved → durable → persisted; unresolved may become rejected only after definitive non-admission evidence. Reserved/durable/persisted never transition to rejected. Queued acknowledgement and worker persistence both require confirmed local AOF durability. Infrastructure retry exhaustion changes processing phase to delayed, never revokes allocation.

## Identity and operational bounds

Canonical identity is ECMAScript `trim().toLowerCase()` everywhere, including configuration, submission, lookup and persistence. Lowercasing is locale-independent Unicode lowercase, not full Unicode case folding. No NFC/NFKC normalization: `É` and `E` + combining acute remain different, as do `ß` and `SS`. `İ` expands to `i` + combining dot; final sigma follows JavaScript lowercase rules. `@`, `.`, spaces within identifiers and other Unicode characters are ordinary. Empty after trim is invalid. NUL is excluded because PostgreSQL text cannot store it.

Shared limits: 16,384-byte JSON body; 8,192-byte encoded request target; normalized identifiers and sale IDs at most 1,024 UTF-8 bytes; opaque key 1–128 printable ASCII bytes excluding spaces. These bound infrastructure/storage, not business identity. Body overflow is HTTP 413; request target overflow is HTTP 414 (proxy may return its native error body). DEV-13 must enforce the shared target cap; existing proxy/API body caps are 16 KiB. Validation and normalization occur before Redis. Reject oversize input without logging identifiers. No truncation.

## Client stale-response rule

Keep order state separately from the latest submission outcome. `reconcileOrder` preserves SUCCESS against delayed PROCESSING/NOT_ORDERED/rejection, and PROCESSING against stale absence or a new rejected placement. `already_placed` reconciles its nested existing order. Lookup UNAVAILABLE retains the last known state with a separate connectivity indicator. Phase changes among processing states are informational and can occur during recovery.

Every request must capture normalized sale/identifier and a local increasing request generation. Ignore responses for a different active identity or older generation; clear displayed state on identity change. Apply reconciliation only to matching identity. A rejection must remain visible as the latest attempt outcome without displaying an existing order as failed. Tests exercise schema boundaries, Unicode, idempotency, HTTP classification, time boundaries and monotonic allocation. Real Redis atomicity and outage behavior remain integration work in dependent issues.
