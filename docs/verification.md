# DEV-6 verification record

Verified on 2026-10-15 with macOS arm64, Node 22.23.2 and pnpm 11.25.0.

Passed:

- `pnpm install --frozen-lockfile` (no lockfile changes required).
- `pnpm build` (all seven workspace packages/apps).
- `pnpm typecheck` (applications, packages and test sources).
- `pnpm lint` (ESLint 10).
- `pnpm test:unit`: 19 tests across four files.
- `pnpm test:browser`: one Chromium smoke test. Browser installation completed before the successful run.
- `docker compose --env-file .env.example config --quiet`.
- `docker compose -f compose.test.yaml --profile stress config --quiet`.
- `git diff --check`.
- Temporary Redis 8.4.0 process in a unique temporary directory: required policy validation, rejection after disabling fsync, independent command/blocking/durability connections, WAITAOF returning `[1,0]`, and marker persistence after process restart. This supplements, but does not replace, the pinned-container integration tests.
- Review mutation: inverted the appendonly safety condition; three Redis policy tests failed. Restored the original source and reran the five Redis policy tests successfully.

Not verified on this machine:

- Docker image builds: attempted, blocked because the Docker daemon socket is absent. Docker CLI is installed; Docker Desktop application is unavailable.
- Full PostgreSQL/Redis integration and volume restart test: `pnpm test:integration` attempted, correctly exits with a missing-daemon message before creating a test project.
- Docker-backed failure and k6 smoke suites: require that same daemon; not run.
- Human clean-machine bootstrap checkpoint: still requires a Docker-capable host.

The source contains executable service/restart checks and documented commands for those outstanding items. No sale throughput or crash-durability assessment results are claimed by this bootstrap.

Self-review covered correctness, secret handling, package boundaries, startup cleanup, test isolation, persistence settings, proxy replica resolution and bounded dependency calls. The test runner uses generated project names, standalone Compose configuration and dynamic ports; it never resets the demonstration volumes. Business behavior remains scoped to subsequent tickets.
