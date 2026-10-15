# Flash sale prototype

The workspace includes the test foundation, sale configuration, shared public contracts and [atomic Redis admission](docs/redis-admission.md). Durability confirmation, worker consumption, HTTP purchase routes and the reactive purchase page follow in DEV-10–DEV-15. The worker currently exposes dependency health and does not consume orders.

## Start from a fresh checkout

Install Node **22.23.2**, pnpm **11.25.0**, and Docker Engine/Desktop with Compose v2. Use `corepack prepare pnpm@11.25.0 --activate` if pnpm is not installed. Docker must be running.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit

docker compose build
docker compose up -d --wait
curl --fail http://localhost:8080/api/health/live
curl --fail http://localhost:8080/api/health/ready
```

Open [localhost:8080](http://localhost:8080). Example credentials are local demonstration values; `.env` is ignored. URL-encode special characters when constructing database URLs. Do not expose these development services to an untrusted network.

For local application development, start only dependencies with `docker compose up -d --wait postgres redis`, then run `pnpm --filter @flash/api start` and `pnpm --filter @flash/worker start` after building. Start Vite with `pnpm dev:web`. The backend start commands load root `.env` using Node. Vite proxies `/api` to the local API at port 3000. Open `http://localhost:5173/?sale=sale-1` (or `http://localhost:8080/?sale=sale-1` with Compose) using your configured sale ID. The default sale ID is `flash-sale`. Identifiers are optionally remembered in local storage; request keys are held only in memory. A lost purchase response can be retried with the same key; pending orders continue polling with backoff capped at 30 seconds, including after closure. The countdown is an estimate; the backend authorizes admission.

## Layout

- `apps/api`, `apps/worker`, `apps/web`: separate executable boundaries.
- `packages/configuration`: validated environment parsing; required URLs fail before listening.
- `packages/database`: bounded PostgreSQL pools, connection and query timeouts.
- `packages/redis`: named connection roles and persistence capability checks.
- `packages/contracts`: shared health and public sale schemas, identity normalization and state rules ([contract and checkpoint A](docs/public-contract.md)).
- `tests/integration`, `tests/failure`, `tests/browser`, `tests/stress`: isolated service checks, failure foundation, browser smoke and k6 smoke.
- `deploy`, `scripts`, `docs`: infrastructure, test orchestration and operational notes.

There are no business domains yet. Subsequent sale code should be grouped by capability inside these boundaries. The two backend entry points intentionally have a small amount of identical lifecycle glue so neither application imports the other.

## Services and resource limits

| Service | Host port | Container port | CPU limit | Memory limit |
| --- | --- | --- | --- | --- |
| Proxy | 127.0.0.1:8080 (`HTTP_PORT`) | 80 | 0.5 | 64 MiB |
| Web | none | 80 | 0.5 | 64 MiB |
| API | none | 3000 | 1 | 512 MiB |
| Worker health | none | 3001 | 1 | 512 MiB |
| PostgreSQL | 127.0.0.1:5432 | 5432 | 1 | 512 MiB |
| Redis | 127.0.0.1:6379 | 6379 | 1 | 512 MiB |

These are development budgets, not measured capacity recommendations. Redis maxmemory is 256 MiB, leaving container headroom for AOF and client buffers. Pools default to 10 connections per API/worker; dependency timeouts default to 2000 ms. API body limit and proxy body limit are 16 KiB infrastructure limits, not business identifier rules.

`/health/live` means the process can serve HTTP. `/health/ready` actively queries PostgreSQL and verifies Redis AOF everysec, noeviction and WAITAOF support; failures return 503 with no connection details. Startup requires these checks to pass. Worker readiness covers dependency access only until consumption is implemented. Web health checks static serving; proxy/API readiness is available at `/api/health/ready`.

```sh
docker compose up -d --scale api=3 --scale worker=2 --wait
```

API replicas have no fixed host ports or container names. Nginx resolves Docker DNS upstream membership every five seconds. This supports basic horizontal routing; admission, bounded overload handling and scaling measurements belong to later tickets. Readiness does not yet implement queue/backlog acceptance policy.

## Persistence and connection ownership

PostgreSQL and Redis use named volumes (`postgres-data`, `redis-data`) scoped to the Compose project. Redis is pinned above 7.2 and uses the same configuration in demonstration and stress environments: AOF enabled, fsync every second, no eviction. There is no unsafe benchmark persistence profile.

Every `createRedisConnection` call owns a separate physical connection:

- `commands`: short, bounded traffic such as readiness; command timeout and offline queue rejection enabled.
- `blocking-consumer`: a dedicated socket per consumer for finite `XREADGROUP BLOCK` calls; never the API command socket.
- `durability`: exclusive ownership for a write and its subsequent `WAITAOF`; do not interleave concurrent write/barrier sequences. WAITAOF covers preceding writes on **that connection**. A separate socket that did not perform the write is not a valid durability barrier.

The Redis package supplies atomic reservation and stream append; durability confirmation is deferred to DEV-10. Future callers must use finite Redis BLOCK/WAITAOF timeouts and handle uncertain outcomes as specified in DEV-10.

Restart without removing volumes:

```sh
docker compose restart postgres redis api worker
docker compose up -d --wait
curl --fail http://localhost:8080/api/health/ready
```

`docker compose down` preserves volumes. Do not use `down --volumes` for the demonstration. A real-service test writes isolated markers, restarts dependencies and checks that the markers remain. PostgreSQL 18 uses its versioned data layout under the mounted `/var/lib/postgresql` directory.

## Verification

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:failure
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:stress
```

Service tests use a standalone Compose file, random project names, dynamic localhost ports, a dedicated `flash_test` database and their own volumes. The runner passes only its discovered endpoints, and cleans up only its generated project. It never reads `DATABASE_URL`/`REDIS_URL` for test data or calls FLUSHALL/TRUNCATE on demonstration services. Tests refuse invocation without the runner's isolation marker. Browser tests start their own Vite server and refuse to reuse an existing one. Unit tests need no running services; their command builds the shared packages first.

Test services and the k6 generator each have a 1 CPU / 512 MiB limit. The k6 script is a readiness smoke check, not evidence of a one-second sale burst or throughput. The [DEV-16 coverage matrix](docs/integration-coverage.md) maps business invariants to executable tests. DEV-17–DEV-19 add deterministic crash boundaries and measured load evidence. Docker Desktop storage and its VM filesystem can have substantially different AOF/fsync latency from bare-metal Linux: record host/VM resources, storage, achieved dispatch, response latency and drain time when benchmarking.

See [docs/framework-guides.md](docs/framework-guides.md) for the official guides consulted and [docs/verification.md](docs/verification.md) for the current verification record.

Sale schema, migration/configuration commands, identifier limits, and partial-initialization recovery: [sale configuration](docs/sale-configuration.md).

### Durable order worker (DEV-11)

The worker consumes each sale's stream through the `orders` consumer group using
separate blocking-read and command connections. Each delivery confirms local AOF
admission durability before opening a PostgreSQL transaction. The unique
`(flash_sale_id, user_identifier)` constraint serializes replays and concurrent
workers; matching admission timestamps reuse the existing order. A missing commit
reply leaves the delivery pending so retry resolves through that same constraint.
Only a confirmed commit permits writing the identifier-to-order mapping in
`<sale admission key>:completed`, followed by `XACK`. Neither acknowledgement nor
completion deletes stream entries or releases reservations. Processing uses the
original admission timestamp and does not recheck the sale window.

Pending deliveries become eligible for reclamation after 60 seconds, well beyond
the normal durability and database statement deadlines. PostgreSQL uniqueness
still protects a slow original worker that resumes after reclamation. Conflicting
identity metadata is retained in `<sale admission key>:quarantine`, keyed by stream
ID; the original entry remains pending for investigation. Transient failures remain
pending. Bounded retry policies, operator replay, and connection recovery are the
follow-up DEV-12 scope.

Run `pnpm test:integration -- tests/integration/orders.test.ts` with Docker running
for real PostgreSQL/Redis concurrent-delivery evidence. Unit tests exercise
transaction rollback, uncertain commit replies, and failures between commit,
completion publication, and acknowledgement.

Retry configuration, operator inspection/replay, reconciliation and checkpoint C: [Recovery runbook](docs/recovery.md).

Operational limits, replica scaling and metric semantics: [operations guide](docs/operations.md).
