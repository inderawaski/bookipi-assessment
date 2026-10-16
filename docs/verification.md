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

## DEV-12 retry and recovery verification

Verified on 2026-10-15 with the same Node/pnpm and pinned service versions:

- `pnpm test:unit`: 51 tests across 13 files passed.
- `pnpm test:integration`: 34 tests across seven files passed.
- `pnpm test:failure`: seven tests across two files passed.
- `pnpm typecheck`, `pnpm build`, `pnpm lint`, `git diff --check`, and
  `node --check scripts/recovery.mjs`: passed.
- Retry ceiling mutation (`Math.min` to `Math.max`) failed the jitter test;
  restored the source and reran successfully.

New real-service coverage exercises durable finite budgets, PostgreSQL outage,
worker consumer restart, repeated replay, one resulting order, retained stock,
missing stream repair, completion repair, partial reconciliation followed by
safe resumption, and fencing on unknown schema. Existing crash/AOF tests still pass.
The outdated missing-stream rejection assertion was changed to require repair.
The first replay polling check incorrectly included a side effect and a timeout
shorter than an AOF sync; final tests poll only read-only readiness before replay.

Self-review covered atomic attempt claiming, replay eligibility, lost replies,
metadata transfer when replacing missing stream entries, reconnect behavior,
configuration safety, startup fences, and sanitized service logs. A database
sale-list dependency was removed from the worker processing loop so a database
outage can actually consume and exhaust the configured retry budget.

No browser or stress run was needed for this backend recovery change. Human
checkpoint C remains pending; follow [the recovery runbook](recovery.md).
Startup reconciliation scans retained sale state atomically and can delay readiness
for large sales; no new throughput or storage-loss guarantees are claimed.

## DEV-13 API verification

Verified on 2026-10-15:

- `pnpm test:unit`: 57 tests across 14 files passed.
- `pnpm test:integration`: 36 tests across eight files passed using isolated PostgreSQL and Redis containers.
- `pnpm test:failure`: seven tests across two files passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check`: passed.
- Pinned Nginx image `nginx -t` with placeholder upstream hosts: passed.

API coverage includes strict schemas, malformed/oversized input, generic encoded identifiers, normalization collisions, idempotency conflicts, explicit duplicates, confirming/queued/delayed states, committed success, sale status/countdown data, missing sales, CORS, database and Redis unavailability, lost-response replay, and replay after closing. A closing-time test exposed the earlier admission implementation's rejection reevaluation; request outcomes now retain their original key/payload binding, including rejections. The old reevaluation assertion and documentation were aligned with the shared contract. Unconfirmed rejection writes remain PROCESSING.

Self-review checked database authority for SUCCESS, fenced absence after reconciliation, preservation of admission evidence after read failures, outcome retention and AOF barriers, schema serialization, input limits, and identifier-free API/proxy logs. Automatic API request logs are disabled; proxy access logs contain only method/status/elapsed time and request error logs are suppressed because Nginx includes raw URLs. No browser or stress run was performed for these backend routes; no new capacity claim is made. The human duplicate/uncertain-response walkthrough remains pending.

## DEV-16 integration and invariant verification

Verified on 2026-10-16 (Asia/Jakarta), macOS arm64, Node 22.23.2,
pnpm 11.25.0, Docker Engine 29.7.2, pinned Redis 7.4.8 and PostgreSQL 18.3:

- `pnpm test:integration`: 40 tests across 10 files passed, including actual dependency restart and the new two-API/two-worker accounting scenario.
- `pnpm test:unit`: 64 tests across 16 files passed.
- `pnpm test:browser`: 20 Chromium tests passed, including browser clocks one day ahead/behind.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, final test-source TypeScript check, `node --check scripts/test-services.mjs`, and `git diff --check`: passed.

Initial sandboxed attempts could not access Docker or bind a localhost test server;
those checks passed with sandbox escalation. The first invariant run reached seven
of eight durable orders within its 15-second drain budget. Each worker delivery
uses separate retry-claim and admission-confirmation AOF barriers; with everysec
fsync, an eight-message batch needs more than that budget. The final bounded
30-second drain check passed with all acknowledged identifiers committed and zero
pending messages. No production timeout or persistence policy changed.

Review covered independent Redis/SQL/acknowledgement accounting, stock conservation,
identifier and request uniqueness, stream order/timestamp evidence, clock restoration,
resource cleanup, replay after closing, group drain and recovery without stock reset.
The runner now builds shared packages before loading service tests, avoiding stale
workspace dist imports on a fresh checkout. Boundary waits observe Redis TIME.
No new production behavior or dependencies were introduced.

See [the P00 coverage matrix](integration-coverage.md) for test names and scope.
API and worker instances run in-process with real service connections; browser tests
stub HTTP. Deterministic process/network failures and measured stress remain owned
by DEV-17–DEV-19. The human invariant/real-service checkpoint remains pending.

## Readiness reconciliation race fix

Verified on 16 October 2026 (Asia/Jakarta), Node 22.23.2, pnpm 11.25.0,
Docker Engine 29.7.2, pinned Redis 7.4.8 and PostgreSQL 18.3:

- `pnpm lint`, `pnpm typecheck`, `pnpm build`, both Compose configuration checks and `git diff --check`: passed.
- `pnpm test`: 70 unit tests and 17 harness tests passed.
- `pnpm test:integration`: 45 tests passed, including 24 overlapping readiness requests across two APIs and one worker, genuine fault fencing/recovery, peer epoch visibility and resumable missing pre-sale configuration.
- `pnpm test:failure`: all 26 deterministic crash/network cases passed, preserving restart fencing, AOF confirmation and acknowledged-admission recovery.
- `pnpm test:browser`: all 22 Chromium cases passed.
- `STRESS_CONNECTIONS=8 STRESS_MAX_CONNECTIONS=8 STRESS_API_REPLICAS=2 STRESS_WORKER_REPLICAS=3 pnpm test:stress healthy`: passed. All five direct replica probes returned HTTP 200/ready. Eight requests were dispatched by 789.05 ms, all eight became orders, and all accounting/fill/drain invariants passed; drain after responses was 10.25 seconds. This is a startup/purchase smoke, not evidence of 100k/s capacity. The five prescribed capacity scenarios were not rerun for this fix; their outstanding limitations remain open.

The new peer-epoch regression failed against the old recovery path because the
marker disappeared before Lua execution, then passed after moving configuration
validation and fencing into one atomic script. Removing in-flight probe sharing
also made both new helper tests fail; the original implementation was restored
and the tests passed. Test-only recovery scheduling uses the existing guarded
constructor callback, with no production fault route or persistence override.

Self-review covered atomic fence visibility across replicas, configuration/expiry
and corruption failures, integer stock validation, missing-state initialization,
unchanged same-connection AOF barriers, non-cached readiness, bounded setup retry
and request cancellation, resource isolation, and unchanged dispatch/boundary
rules. No unresolved review findings were identified. PostgreSQL health now runs
authenticated SQL over TCP instead of accepting its temporary initialization
server. The readiness harness retains every replica's status/error attempts.

Local logs, code checksums and the healthy-run evidence are retained under
`test-results/readiness-fix/`; the raw stress project is
`test-results/stress/flash-test-8ded42a4-d697-4033-8b79-04dc726040c3/`.
Generated artifacts remain ignored so final-commit metadata can be saved without
changing the commit it identifies. User approval of checkpoints A–G and final
human review, plus the updated uncertainty contract, are recorded in the
[submission audit](submission-audit.md). No performance waiver or external
submission authorization is inferred from those approvals.
