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

## DEV-8 contract verification

Verified on 2026-10-15 with the same Node/pnpm versions:

- `pnpm --config.verify-deps-before-run=false test:unit`: 31 tests across eight files, including shared contract rules and Fastify schema validation.
- `pnpm --config.verify-deps-before-run=false typecheck`, `lint`, and `build`: passed (the same pnpm option was used for each command).
- Opening-boundary mutation (`<=` changed to `<`): the boundary test failed as expected; restored the source and reran the full checks above successfully.
- `git diff --check`: passed.

Dependency links were restored using `CI=true pnpm install --frozen-lockfile` with registry access. The pnpm per-run dependency check was disabled for verification because sandboxed and unsandboxed pnpm invocations selected different store contexts and otherwise attempted to recreate node_modules. This option skips automatic installation, not any test/compiler/linter checks. The lockfile change adds only the internal database → contracts workspace link.

Self-review covered explicit attempt/order separation, uncertainty versus definite rejection, Unicode and byte bounds, key conflicts and sale scope, non-revocable allocation transitions, schema/type correspondence, and stale-response handling. Review caught the printable-key regex end-anchor accepting a trailing newline; validation now rejects any non-printable character, with tests for that case.

This issue introduces no live purchase/lookup routes or Redis admission implementation. Real-service outage/atomicity/durability tests remain in dependent implementation tickets. Checkpoint A examples are in [public-contract.md](public-contract.md); human approval remains pending before DEV-9.

## DEV-10 durability verification

Verified on 2026-10-15, macOS arm64, Node 22.23.2, pnpm 11.25.0,
Docker Engine 29.7.2, pinned Redis 7.4.8 and PostgreSQL 18.3 containers:

- `pnpm lint`, `pnpm typecheck`, `pnpm build`: passed.
- `pnpm test:unit`: 46 tests across 10 files passed.
- `pnpm test:integration`: 31 tests across five files passed.
- `pnpm test:failure`: seven tests across two files passed, including the
  wrong-connection fsync proof and five SIGKILL/restart boundaries.
- Barrier mutation (`reply[0] !== 1` inverted): five of ten focused tests failed;
  restored the condition and reran the unit suite successfully.
- `git diff --check`: passed.

Review covered ownership of write/wait sockets, bounded concurrency, deadlines,
replay/duplicate/worker confirmation, restart fencing, DB/stream association
checks, pending-stock accounting, AOF health and conservative absence semantics.
No unresolved correctness findings were identified in that review.

The first service run exposed Docker's ephemeral host-port reassignment on
restart (observed Redis port 57984 becoming 57989). The runner now selects ports
once per isolated project. A later run exposed an older test's assumption that
300 ms sufficed for everysec local fsync; it now confirms local durability before
independently testing the absent replica's timeout. Final integration and failure
runs above passed after these corrections; neither fix relaxes the admission
barrier.

See [the protocol and proof boundaries](admission-durability.md). HTTP response
loss is simulated at the library boundary because public routes are a later
issue. No power-loss, storage-loss or stress-capacity claims are made. Human
checkpoint B remains pending review of the protocol and crash evidence before
broader feature work.
