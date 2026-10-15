# Schema and sale configuration

Copy `.env.example` to `.env`, start PostgreSQL/Redis (`docker compose up -d postgres redis`), then run:

```sh
pnpm db:migrate
pnpm sale:configure 'sale-1' '2030-01-01T10:00:00+07:00' '2030-01-01T11:00:00+07:00' 100
```

Choose future instants for a new sale. Zero stock explicitly configures a sold-out sale. ISO timestamps require an explicit timezone and at most millisecond precision; storage uses UTC instants. Stock is an integer from 0 through 2147483647. Migration is transactional, serialized, and rerunnable on a fresh or existing schema; it creates only `flash_sale` and `"order"`. Always quote the latter SQL keyword. Orders represent one unit and reference a sale, with unique `(flash_sale_id, user_identifier)` and completed time at or after admission time.

Configuration commits PostgreSQL first, then atomically creates the Redis admission hash, and confirms local AOF durability on the same dedicated connection. Persisted configurations are immutable (including before opening); use a new sale ID for a different configuration. Repeating identical configuration verifies the immutable fields and preserves remaining stock and all other Redis reservation/queue state. No startup path seeds stock.

A crash after the DB commit leaves readiness unavailable until configuration matches in Redis. Repeat the same command before opening to resume safely. Missing Redis state at or after opening requires operator repair, even if the sale has ended or stock is zero. Never delete the sale/hash or blindly recreate stock: inspect retained AOF, finalized orders and queue/reservation records, recover consistent state from durable storage, then verify readiness. Storage loss is outside the recovery guarantee. An uncertain AOF confirmation may be retried with the identical command; its write barrier covers the existing configuration too. Existing matching state may be checked/retried after closing without reseeding. Configuration commands must target a private operational Redis endpoint; public requests do not run these commands.

API and worker readiness checks validate every persisted sale against Redis; a mismatch prevents readiness/startup. An unmigrated bootstrap remains available for infrastructure checks, and contains no configured sales. Admission must use these same hash keys and immutable fields, checking time/stock atomically (DEV-9). Public purchase routes and status enums follow in DEV-8/DEV-13.

## Identifier contract and operational limits

Identifiers are arbitrary strings normalized with JavaScript `trim().toLowerCase()`. Empty normalized values are invalid. No email/username syntax is imposed. SQL values are bound parameters. Sale IDs use the same normalization. Application writers must call `normalizeIdentifier` before storing orders; SQL constraints additionally reject empty/untrimmed/nonlowercase values. Normalization collisions intentionally represent the same identifier.

Operational limits: normalized identifiers are limited to 1024 UTF-8 bytes to bound PostgreSQL unique-index entries and Redis keys; NUL cannot be represented in PostgreSQL text and is rejected. The current HTTP body limit is 16384 bytes. These infrastructure limits are not identity syntax rules. Redis keys hex-encode sale IDs to keep braces and arbitrary characters safe. The hash stores `starts_at`/`ends_at` as epoch milliseconds, `initial_stock`, `remaining_stock`, and `configuration_version`. Remaining stock zero is sold out; it must never be reset by configuration retries.

Tests: `pnpm test:unit`, `pnpm test:integration`. Integration tests use disposable isolated services and cover migration reruns, constraints, normalization collisions, partial initialization, zero stock, immutable configuration, preserved reservations, and ended-sale recovery behavior.
