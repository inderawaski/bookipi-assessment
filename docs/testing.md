# Testing and expected outcomes

This integrates the approved testing strategy with executable commands and measured evidence. Expected outcomes below are requirements, not capacity claims.

## Commands and isolation

From the repository root, with Node 22.23.2, pnpm 11.25.0 and a running Docker daemon:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:failure
pnpm test:stress no-oversell duplicates sufficient-stock burst-10s burst-3s burst-1s spike-10k
pnpm test:stress healthy sufficient-stock opening closing closing-worker-crash worker-crash repeated
```

`pnpm test` runs unit plus Node harness tests. Unit tests build shared packages automatically. Integration builds packages, failure builds all apps/packages, and each runner creates random `flash-test-UUID` projects with real PostgreSQL 18.3 / Redis 7.4.8, AOF everysec, noeviction and WAITAOF. Integration/stress cleanup deletes only its own disposable volumes; failure cleanup preserves its volumes and saves JSON/log/trace evidence under `test-results/failure/PROJECT/`. No demo reset or demo `.env` is needed for these runners. See [safe recovery versus destructive test cleanup](recovery.md).

Playwright starts Vite on 127.0.0.1:4173 and stubs HTTP; it verifies browser behavior, not Docker end-to-end persistence. Keep that port free. Real cross-component persistence belongs to integration/failure tests. The optional `node scripts/test-services.mjs stress` is a k6 health smoke, not the one-second purchase benchmark.

See the [stress harness guide](../scripts/stress/README.md) for socket caps, automatic retries, replica overrides and artifact collection. To retain compressed artifacts from a new run: `node scripts/stress/report.mjs test-results/stress/PROJECT` with the actual isolated project path. Include invalid attempts.

## Unit and component tests

Test trim/lowercase normalization, empty invalid input, arbitrary punctuation, request schemas, status mapping, duplicate versus replay, retry/backoff/exhaustion, countdown calculation and exact start-inclusive/end-exclusive predicate. Frontend tests cover debounce, stale responses, in-memory request key and immediate submission lock. Lua integration uses real Redis, not a mocked concurrency model.

## Integration

Use real Redis/PostgreSQL with actual AOF/barrier settings. Test atomic last-stock contention, same-identifier contention, replay after closing, identifier collisions, unique database order constraint, repeated stream delivery, transaction ambiguity, startup initialization and recovery accounting. Run more than one API and worker instance. Verify authoritative Redis admission order/time rather than response ordering.

Expected invariants:

```text
allocations <= initial_stock
allocations_per_sale_identifier <= 1
orders_per_sale_identifier <= 1
each acknowledged admission -> one completed order after recovery/drain
starts_at <= each new admission timestamp < ends_at
```

Do not count one reservation and its completed order as two allocations. No record during outage/recovery does not imply rejection.

## Failure matrix

| Injection boundary | Expected result |
| -- | -- |
| API before sending Lua | No allocation; retry allowed |
| API after send before response | Uncertain; reconcile safely |
| Redis before local persistence | No false acknowledgement; uncertain outcome resolved safely |
| Redis after persistence before API reply | Allocation recovers through identifier lookup |
| Worker reads unconfirmed stream message | Cannot finalize until durability established |
| Worker before/inside DB transaction | Retry safely; rollback if uncommitted |
| DB commit response lost | Detect existing order on replay |
| Worker after DB commit before status/ack | Repair status and ack; one order |
| Redis status/ack update lost | Replay idempotently |
| Retry exhaustion | Reservation retained, delayed status, manual replay |
| Crash during replay/reconciliation | Resume safely; no double accounting |
| Late original admission after attempted absence resolution | Fencing prevents false rejection followed by allocation |

Abruptly terminate processes and interrupt connections using deterministic test-only failpoints. Preserve volumes. Include persistence waits, AOF rewrite and readiness recovery. Every case records trace, invariant checks and final convergence. Persistent-volume destruction is explicitly outside the guarantee.

## Stress scenarios

The [stress harness guide](../scripts/stress/README.md) defines the revised seven
required workloads: two synchronized correctness/duplicate cases, a 1,000-stock /
1,000-buyer processing burst, three 5,000-buyer bursts over 10/3/1 seconds, and a
10,000-buyer one-second spike with 100 stock. Every request must be dispatched
inside its declared window; generator-invalid runs do not establish capacity.

The healthy spike must fill all 100 units and preserve all correctness invariants.
Admission-to-committed-order visibility p99 must be under two seconds, and every
admitted order must be visible within ten seconds. Visibility uses PostgreSQL's
clock and includes sampling delay; pre-commit completed_at is not commit evidence.
Recovery and boundary experiments retain separate acceptance criteria.

## Measurements and interpretation

Record commit SHA, dependency versions, machine/OS, Docker resources/storage, network/load-generator placement, persistence settings, replica counts, pool sizes, stock and identity mix. Capture actual dispatch span, request outcome counts, p50/p95/p99 response and durability latency, CPU/memory/network/disk, backlog, drain/recovery time and final allocation/order accounting.

In healthy runs with enough eligible requests reaching admission, allocate min(stock,unique eligible identifiers). Saturation may produce fewer admissions with explicit pre-admission busy or uncertain outcomes. Every request outcome is accounted for, and acknowledged admissions cannot be lost. Timeouts are uncertain, not proof of rejection.

## Final PostgreSQL stock-cap verification

The user approved a final stock guard after a modeled Redis rollback crossed an
in-flight PostgreSQL commit. [The guard report](final-stock-cap-results.md) records
the implementation, regression, mutation check and a new healthy spike. Matching
full-capacity replay remains valid; conflicting new work is quarantined and fences
admission. Redis acknowledgement remains immediate and asynchronous replication
remains one replica. Earlier measurements below are retained separately.

## Current immediate-acknowledgement verification

The [immediate acknowledgement report](async-admission-results.md) records the
approved loss trade-off, one asynchronous Redis replica, test changes and a healthy
10,000-buyer spike. It filled 100 units with approximately 365-ms order p99, while
4,105 HTTP 504s remain an unresolved overload issue. The older scale-out and DEV-19
measurements below used persistence barriers and do not describe current behavior.

## Spike scale-out results

The [four-way scale-out experiment](scale-out-results.md) records the rationale,
valid matched runs and all invalid calibration attempts. Scaling APIs improved
admission and scaling workers improved completion, but none met the new latency
targets. The report separates these findings from Redis bottleneck hypotheses. A
reverse-order follow-up (3/3 before 3/1) produced 100 and 90 orders respectively,
showing the earlier allocation ranking was not stable.

## Historical DEV-19 measured summary

These results used the former workload definitions. They do not establish that
the revised suite or new latency targets pass.

Measured 16 October 2026 (Asia/Jakarta), M4 Pro / 24 GiB, macOS Darwin 25.5.0, Docker VM 12 CPUs / 7.748 GiB, Node 22.23.2, pnpm 11.25.0. Engine 29.7.2 / Compose 5.4.0; PostgreSQL 18.3 / Redis 7.4.8. One CPU / 512 MiB per API, worker and database; stress proxy one CPU / 512 MiB. Defaults: HTTP/admission concurrency 64/16, admission deadline 3000 ms, DB pool 10, dependency deadline 2000 ms. The generator runs on the host through localhost published proxy; volumes use overlayfs in the Docker VM. Exact configuration, dirty/base commit, runtime versions, host limits and resource samples are in each artifact. Physical fsync device latency was not measured.

Only three prescribed scenarios have valid one-second dispatch. The 100k/s target remains unmet. Outcomes account for every request; confirming can later become an order and is not a rejection. Tables below derive directly from [summary.json](evidence/dev19/summary.json); [manifest](evidence/dev19/manifest.json) provides raw artifact checksums. Offered requests in a valid one-second window describe offered load, not successful response/order throughput.

| Scenario / raw result | Last write ms / dispatch | Q / U / B / P (other) | p95 / p99 ms | Orders | Drain s |
| --- | --- | --- | --- | --- | --- |
| [stock100-1k](evidence/dev19/flash-test-bb3f2fd6-686b-4f8f-aab0-e8f26fae942e/stock100-1k/result.json.gz) | 899.38 / valid | 15 / 0 / 985 / 0 | 257.60 / 2359.03 | 15 | 28.42 |
| [stock100-10k](evidence/dev19/flash-test-0aefe7e8-9cc2-48d7-b060-7d88e55f6981/stock100-10k/result.json.gz) | 947.11 / valid | 26 / 21 / 8975 / 978 | 2693.43 / 2753.62 | 47 | 38.08 |
| [duplicates](evidence/dev19/flash-test-38d78af7-9ffd-44a9-84fb-ef50736bbb44/duplicates/result.json.gz) | 900.97 / valid | 18 / 27 / 9383 / 563; 9 duplicate | 2941.87 / 4392.51 | 45 | 86.11 |
| [stock100-100k](evidence/dev19/flash-test-92a409c1-59bc-4bf7-8356-3458ed2d3a3a/stock100-100k/result.json.gz) | 16547.24 / invalid | 14 / 86 / 75387 / 24339; 174 sold out | 6249.84 / 8076.22 | 100 | 181.73 |
| [stock10k-100k](evidence/dev19/flash-test-9053f623-70d3-4b8b-9e19-717e33a01a6e/stock10k-100k/result.json.gz) | 9292.18 / invalid | 16 / 146 / 99315 / 523 | 358.02 / 2320.79 | 178 | 112.36 |

Q = queued/delayed acknowledged responses; U = confirming; B = busy; P = non-JSON proxy responses. Latency percentiles include completed HTTP responses (mostly busy under saturation), not order completion. All five selected runs passed final accounting invariants, including acknowledged-admission preservation, even where dispatch was invalid. Maximum backlog and AOF barrier sum/count are sampled in raw metrics; no continuous backlog maximum or durability p95/p99 is available, so those measurements are not claimed. Response completion and drain occur after dispatch and are reported separately in artifacts.

The valid 10k unique run admitted 47 rather than 100 due to saturation. Three APIs increased the sufficient-stock comparison from 16 to 48 admissions; adding three workers reduced comparable drain from 96.30 to 40.96 seconds. AOF confirmation cadence, bounded admission slots and serial worker drain limit the small workloads; larger runs also encounter ingress and generator/port limits. This does not establish disk saturation or PostgreSQL maximum write capacity. [Detailed results](stress-results.md) retain failed attempts, resource measurements, replica/boundary/recovery evidence and historical verification (67 unit, 10 harness, 40 integration, 26 failure tests). [DEV-16 browser verification](verification.md#dev-16-integration-and-invariant-verification) records 20 browser tests; these are prior measurements, not newly run checks.
## Requirement-to-test mapping

[The integration coverage matrix](integration-coverage.md) maps schema, admission, fairness, time boundaries, duplicate/replay, durability, multi-instance accounting and recovery requirements to exact test names. [The failure matrix](failure-matrix.md) maps process/network injection boundaries and saved evidence. Paths in those matrices are relative to `tests/integration`, `tests/failure` or the explicitly named package. Additional concrete cases:

| Requirement | Source and test name |
| --- | --- |
| Normalization, arbitrary punctuation, empty input, immediate double-submit lock | `tests/browser/purchase.spec.ts`: `normalizes arbitrary identifiers, rejects empty input and locks double submission` |
| Debounce and network recovery | Same file: `lookup debounces edits and recovers after a network error` |
| Stale response isolation | Same file: `late lookup and purchase cannot overwrite a different identifier`; `lookup started before submission cannot erase placed state` |
| In-memory retry key and uncertain outcome | Same file: `uncertain delivery retries the same key and recovers to success`; `automatic lookup resolves uncertain confirmation and clears its warning` |
| Refresh after closure | Same file: `refresh retrieves remembered pending and successful orders after sale ends` |
| Live closing/countdown behavior | Same file: `sale status refresh disables purchase when the sale closes`; `keyboard submission shows busy feedback and backend closing race rejection` |
| Transport ambiguity and encoded lookup | `apps/web/src/sales/client.test.ts`: `treats proxy errors as uncertain delivery rather than a rejection`; `encodes lookup identifiers as query data` |
| Exact start-inclusive/end-exclusive predicate | `tests/integration/admission.test.ts`: `evaluates exact opening and closing boundaries with the production Lua predicate` |
| Stock/order/acknowledgement accounting across replicas | `tests/integration/invariants.test.ts`: `accounts independently for acknowledged admissions across two APIs and workers after closing and recovery` |
| One-second dispatch, real sockets and accounting | `scripts/stress/accounting.test.mjs`: `missing, late, duplicate and inconsistent dispatch evidence invalidates runs`; `real socket evidence detects acquisition stretch after iteration starts`; `preconnected clients reach a real server in the dispatch window`; `final accounting detects oversell, loss, duplicates, mismatches and an undrained queue` |

Countdown rendering is exercised in browser scenarios; no standalone countdown unit test is claimed. Pure predicate tests supplement real Redis TIME boundary evidence rather than replacing it.

## DEV-21 documentation verification

On 16 October 2026, `pnpm lint`, `pnpm typecheck`, `pnpm build`, both demonstration/test Compose configuration checks, operator-script syntax checks and relative documentation-link checks passed. `pnpm test` passed 68 unit tests and 10 harness tests after allowing localhost socket access; the initial sandbox run failed with `listen EPERM`. No application changes were needed. Integration, failure, browser, full fresh-checkout Docker walkthrough and stress suites were not rerun for this documentation change; their historical results are identified above. Existing demonstration reservations were not modified. Human checkpoint G is still pending.

## Final submission audit

[DEV-22 requirement traceability and rehearsal](submission-audit.md) maps the full behavioral contract to code, tests and deliverables, defines the final-commit verification receipt and records pending human/performance acceptance gates. Run `node scripts/submission-check.mjs` only after committing all changes; preserve its ignored evidence alongside the exact verified revision.

## Human checkpoint G

**Approved by user confirmation in this chat on 16 October 2026; see the [reviewer record](submission-audit.md).** The following walkthrough is retained for reproduction:

1. Clone [the source repository](https://github.com/inderawaski/bookipi-assessment) and follow README prerequisites, environment, install/build, infrastructure, migration and pre-opening configuration exactly. Record source revision with `git rev-parse HEAD`, versions, sale ID, UTC times and initial stock.
2. Open the documented URL, wait for ACTIVE, place an arbitrary identifier, observe PROCESSING then SUCCESS, retry deliberately and confirm duplicate feedback; refresh and confirm the same order.
3. Save sale status/remaining stock, order ID and `recovery.mjs inspect` output. Stop the worker, place another identifier, retain its processing reservation, then stop/start services without deleting volumes. Confirm both identifiers produce exactly one order each, and inventory reflects the same allocations.
4. Rerun `sale:configure` with the **original** ID, times and stock (not newly generated times); confirm stock and existing reservations are unchanged. Use a fresh sale ID for later demonstrations. Never reset an existing sale.
5. Follow inspection/replay instructions for exhausted disposable work and distinguish readiness recovery from queue drain. Run the documented suites; inspect dispatch validity and accounting artifacts. Record any unstated step as a documentation defect.
6. Record date, reviewer, checkout revision, commands, screenshots/status evidence and pass/fail. Keep checkpoint pending until a person supplies that evidence. The two invalid 100k bursts remain submission limitations.

Redis-only purchase admission follow-up: [verification and spike evidence](redis-only-admission-results.md). The route regression asserts no database/probe calls; integration covers a closed/exhausted PostgreSQL pool and retained Lua fences.

Sale metadata cache: [read flow, safety and verification](sale-configuration-cache.md).

Redis admission pooling: [implementation, safety checks and spike evidence](pooled-admission-results.md).

Waitable Redis admission acquisition: [current library-default policy and historical 10-ms measurements](waitable-admission-pool.md).


Redis lease sizing instrumentation covers purchase acquisition/lease histograms,
active peak and expiry counters. The overload integration suite verifies a single
connection is released before post-reply processing finishes; crash/network tests
retain acknowledgement uncertainty coverage across the new boundary.

[Measured pool sizing and archived verification](redis-lease-sizing.md) compares
8/16/32 connections per API with separate acquisition and purchase lease metrics.


Current [framework default concurrency policy and verification](framework-default-policy.md)
supersedes the HTTP guard and fixed service pool sizes in historical benchmarks.
