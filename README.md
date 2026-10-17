# Flash Sale

## System Design

```mermaid
flowchart LR
    Frontend[React frontend] --> API[Fastify API]
    API --> Redis[Redis]
    Redis --> Worker[Order workers]
    Worker --> DB[(PostgreSQL)]
```

The system uses TypeScript, Fastify, React + Vite, Redis and PostgreSQL. Redis Lua atomically checks the sale window, prevents duplicate allocations and reserves stock in Redis execution order. It also enqueues accepted purchases in Redis Streams. Workers process reservations asynchronously and commit orders to PostgreSQL, keeping database writes off the purchase admission path. API and worker replicas can scale independently; PostgreSQL uniqueness constraints and a per-sale final stock cap protect committed orders from duplicates and overselling.

Admission returns after the Redis primary acknowledges execution, favoring low latency over crash-safe reservation durability. AOF every second and asynchronous replication can lose acknowledged reservations on Redis failure; only a committed PostgreSQL order represents final success. Surviving reservations can be retried after worker or database failures. Redis remains the single-sale admission bottleneck, status polling can lag, and the local deployment does not provide automatic failover or host/region redundancy.

### Comprehensive System Design

> **[Read the complete system design →](docs/system-design.md)**
>
> Explore the full architecture, request flows, design decisions and recovery behavior.

## Build & Run

Run commands from the repository root. Install Node.js 22.23.2 and pnpm 11.25.0, and start Docker with Compose support and Linux containers. Keep local ports 8080, 5432 and 6379 available; browser tests also use 4173.

Install dependencies, build all packages and applications, start infrastructure, and apply migrations:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
docker compose up -d --wait postgres redis redis-replica
pnpm db:migrate
```

Configure a sale before it opens. This example starts in five minutes and lasts one hour:

```sh
SALE_START=$(node -p 'new Date(Date.now()+300000).toISOString()')
SALE_END=$(node -p 'new Date(Date.now()+3900000).toISOString()')
pnpm sale:configure flash-sale "$SALE_START" "$SALE_END" 100
```

Start the API server, order workers, frontend and proxy:

```sh
docker compose up --build -d --wait
```

Open [the frontend](http://localhost:8080/?sale=flash-sale). The API is available through the same origin under `/api`; readiness is at [`/api/health/ready`](http://localhost:8080/api/health/ready). Enter a nonempty buyer identifier to purchase; each normalized identifier can receive one unit per sale.

The configuration command accepts `ID START_ISO END_ISO STOCK`. Existing sale times and initial stock cannot be changed. Use a new ID for another sale and open `/?sale=that-id`; an identical configuration can be retried safely.

Inspect or stop the running services:

```sh
docker compose ps
docker compose logs --tail=100 api worker
docker compose stop
```

Use `docker compose start` to resume stopped services. Named volumes retain sale and order data.

Run static checks and tests:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:failure
```

`pnpm test` runs unit and harness tests. Integration and failure tests start isolated Docker Compose projects; browser tests start Vite automatically and use stub HTTP responses. Integration cleanup removes its disposable volumes; failure runs retain their own volumes for inspection.

## Stress Test

### Instructions

With dependencies installed and Docker running, run the seven required workloads:

```sh
pnpm test:stress
```

Run an individual workload by name:

```sh
pnpm test:stress no-oversell
pnpm test:stress duplicates
pnpm test:stress sufficient-stock
pnpm test:stress normal-burst
pnpm test:stress aggressive-burst
pnpm test:stress extreme-burst
pnpm test:stress spike-10k
```

The default deployment uses six API replicas and one worker. Each attempt builds
an isolated Compose project with a fresh sale and disposable data volumes. The
harness preconnects up to 5,000 sockets and schedules requests independently of
responses over 90% of the dispatch window; `no-oversell` and `duplicates` release
requests together. Every request write must finish before its scenario's deadline.
This measures writes handed to the operating system, not server receipt or
response completion.

All workloads check stock conservation, unique allocations/orders, matching
admissions and completed work. The primary `spike-10k` target is 10,000 unique
requests within one second with 100 stock, zero proxy/transport errors, all 100
orders committed, order visibility p99 below two seconds and every admitted order
completed within ten seconds. `sufficient-stock` reports allocation and order
latency without requiring full allocation or the spike's latency gates.

`STRESS_API_REPLICAS`, `STRESS_WORKER_REPLICAS`, `STRESS_CONNECTIONS` and
`STRESS_MAX_CONNECTIONS` allow explicit overrides. Generated diagnostics go to
`test-results/stress/` and are not retained in the repository. Cleanup removes
only that attempt's disposable service volumes.

### Stress Test Outcomes

> **[Read the stress-test outcomes →](docs/stress-testing.md)**
>
> Latest results for the seven required workloads with six pre-scaled APIs.
