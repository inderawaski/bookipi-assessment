# High-throughput flash sale assessment

A single-product flash sale demonstration using TypeScript, Fastify, React, Redis Streams and PostgreSQL. Redis performs atomic admission and stock reservation; workers finalize orders asynchronously. The interface actively retrieves sale and order status.

## Behavior

Enter a nonempty user identifier and select Buy Now during the sale. Identifiers are trimmed and lowercased; they are not authenticated accounts. Each identifier may secure one unit per sale.

Requests are admitted in authoritative Redis execution order. Stock is reserved at admission, protecting accepted buyers from slow processing. The sale window is start-inclusive/end-exclusive and governs admission, not completion. A placed order is acknowledged only after local Redis persistence is confirmed. Uncertain requests show processing/confirming. Internal failures delay processing without revoking reservations.

The page reports upcoming, active, ended and sold out; explicit duplicate feedback; and processing/success. Accidental duplicate submissions reuse one in-memory request key. Refresh uses identifier-based lookup. There is no payment, authentication, catalogue, quantity selector or admin interface.

## Architecture and trade-offs

See [architecture](<docs/architecture.md>) for the system diagram and complete flow, [decisions](<docs/decisions.md>) for rationale, [recovery](<docs/recovery.md>) for failure handling, and [testing](<docs/testing.md>) for test strategy and results.

Redis uses AOF everysec with explicit durability confirmation before acknowledging placement. This trades acknowledgement latency for durability and persistence batching. API and worker instances scale independently; Redis remains the single-sale admission limit. PostgreSQL uses an order uniqueness constraint for safe replay. Local service crashes with intact volumes are handled; storage loss and host/regional redundancy are excluded.

## Prerequisites

Validated environment: macOS arm64 (Darwin 25.5.0), Apple M4 Pro / 24 GiB, Docker Desktop 4.88.1, Engine 29.7.2, Compose 5.4.0; Docker VM 12 CPUs / 7.748 GiB. This is measured host configuration, not a minimum resource guarantee. Linux containers are required; other hosts need their own verification. Images pin Node 22.23.2, PostgreSQL 18.3, Redis 7.4.8 (supports WAITAOF) and Nginx 1.28.2. Install local Node 22.23.2 and pnpm 11.25.0 for operator scripts/tests. Git and a running Docker daemon are required. Free localhost ports 8080, 5432 and 6379; browser tests additionally use 4173.

## Build and run

Source repository: [inderawaski/bookipi-assessment](https://github.com/inderawaski/bookipi-assessment). Clone it and run the remaining commands from its root:

```sh
git clone https://github.com/inderawaski/bookipi-assessment.git
cd bookipi-assessment
```

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
docker compose up -d --wait postgres redis
pnpm db:migrate
```

Configure before opening. Generate UTC times five minutes ahead and a one-hour window, so the example remains usable on any date:

```sh
SALE_START=$(node -p 'new Date(Date.now()+300000).toISOString()')
SALE_END=$(node -p 'new Date(Date.now()+3900000).toISOString()')
pnpm sale:configure flash-sale "$SALE_START" "$SALE_END" 100
docker compose up --build -d --wait
```

The configuration CLI accepts exactly `ID START_ISO END_ISO STOCK`; retain those values for an identical retry. Existing sales cannot have their times or initial stock changed. Do not regenerate times and reuse an existing ID. Use a new ID for a new sale and open `/?sale=that-id`. If setup misses opening before Redis initialization, do not bypass the safety check.

Open [the purchase page](http://localhost:8080/?sale=flash-sale). Same-origin endpoints: `GET /api/sales/flash-sale`, `POST /api/sales/flash-sale/purchases`, `GET /api/sales/flash-sale/order?identifier=buyer`, `GET /api/health/live`, `GET /api/health/ready`, `GET /api/metrics`. See [request examples and limits](docs/public-contract.md).

```sh
docker compose up -d --scale api=2 --scale worker=2
docker compose ps
docker compose logs --tail=100 api worker
docker compose stop
docker compose start
```

The proxy resolves API replicas; API/worker ports are internal. Worker health can be checked with `docker compose exec worker node -e "fetch('http://127.0.0.1:3001/health/ready').then(async r=>console.log(r.status,await r.text()))"`. `docker compose down` also preserves named volumes; recreate with `docker compose up -d`. Never add `--volumes` to a demo shutdown. The environment example contains local-only credentials and binds infrastructure to loopback.

Configuration is idempotent and cannot replenish inventory on restart. Times and initial stock cannot be changed after admission initialization. Resetting disposable test data is a separate explicitly destructive operation and must not target demonstration volumes.

## Tests

See [testing commands, coverage and evidence](docs/testing.md). Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:integration`, `pnpm exec playwright install chromium`, `pnpm test:browser`, `pnpm test:failure` and `pnpm test:stress stock100-1k`. Service/stress runners create random isolated projects. Integration/stress cleanup deletes only their disposable volumes; failure runs retain their own volumes. Browser tests use stub HTTP and start Vite automatically.

The stress suite dispatches 1k, 10k and 100k-request scenarios within one second, including 100-stock and 10k-stock cases and duplicate identifiers. Additional tests cover opening/closing boundaries, multi-instance operation, overload and crash recovery. Actual dispatch timing validates the generator; response completion/queue drain are separate measurements.

Expected correctness: no overselling; one allocation/order per identifier per sale; acknowledged admissions survive local crashes and complete once services/recovery restore operation. Saturation can return retryable busy before admission. Uncertain responses are reconciled rather than counted as rejection.

## Stress results

[Measured results](docs/stress-results.md) and [raw artifacts/manifest](docs/evidence/dev19/manifest.json) report three valid prescribed bursts and two invalid 100k bursts. On the M4 Pro host above, the valid 10k-unique run (one API / three workers, 5,000 sockets) wrote its last request at 947.11 ms: 8,975 busy, 21 confirming, 26 queued/delayed, 978 non-JSON proxy responses; 47 admissions became 47 orders. Response p95/p99: 2,693.43 / 2,753.62 ms; drain after responses: 38.08 s; all accounting invariants passed. The stress proxy uses one CPU / 512 MiB, larger than the demo proxy. Both 100k bursts exceeded one second; measured 100k/s capacity is unproven. Bounded admission slots, AOF cadence, serial worker drain and generator/ingress saturation are documented limits. The full per-scenario table is in [testing](docs/testing.md).

## Recovery and limitations

Use [recovery runbook](<docs/recovery.md>) to inspect pending work and replay delayed processing. Never restore stock by simply rerunning seed or subtracting finalized orders alone. Pending reservations also consume stock. Missing data during outage is not definitive rejection.

No payment, fraud, shipping eligibility or other external business rejection exists; valid admitted work has no defined permanent business failure. Eventual success assumes service recovery/manual remediation and intact persistent storage. The system does not verify human identity. Future authentication could introduce a user foreign key; multiple products require a product entity and revised relationships.

Operator examples: `node --env-file=.env scripts/recovery.mjs inspect flash-sale` and `node --env-file=.env scripts/recovery.mjs replay flash-sale 1234567890000-0` (replace the example stream ID with the inspected exhausted entry). Read the runbook first. [Operational limits](docs/operations.md) describe bounded pools, proxy deadlines and retained-stream storage growth.

See the [final requirement audit, verification receipt and submission walkthrough](docs/submission-audit.md). Run `node scripts/submission-check.mjs` from a clean final commit to collect SHA-pinned evidence. Performance gaps and human approvals remain explicit submission gates.

Record the final submission commit with `git rev-parse HEAD`. Human checkpoint G remains pending: a person must follow the [fresh-checkout rehearsal](docs/testing.md#human-checkpoint-g) and record evidence before acceptance.
