# Final requirement audit and submission rehearsal (DEV-22)

Audit source: [DEV-5 behavioral contract](https://linear.app/bookipi-assessment/issue/DEV-5/deliver-the-high-throughput-flash-sale-assessment) and [DEV-22 acceptance criteria](https://linear.app/bookipi-assessment/issue/DEV-22/perform-final-requirement-audit-and-submission-rehearsal), reviewed 16 October 2026 (Asia/Jakarta).

**Submission acceptance remains pending.** Two prescribed 100k bursts have invalid dispatch evidence, human checkpoints A–G and the final walkthrough have no recorded human sign-off. Automated passing tests cannot close those gaps. This audit adds no authentication, product entity, quantity option or other business behavior. It does not authorize external submission.

## Requirement traceability

Paths below are repository-relative. Integration test names and detailed crash boundaries are expanded in [integration coverage](integration-coverage.md) and [failure matrix](failure-matrix.md). Historical test totals are in [verification](verification.md); fresh results must come from the final-commit receipt below.

| Original requirement | Implementation | Test/evidence | Explanation / status |
| --- | --- | --- | --- |
| TypeScript, Fastify, React, Redis, PostgreSQL, Compose | `apps/api`, `apps/web`, `apps/worker`, `packages`, `Dockerfile`, `compose.yaml` | Workspace build/typecheck; integration `services.test.ts`; fresh checkout below | [README](../README.md), [architecture diagram](architecture.md) |
| Exactly flash_sale and order tables; implicit single product; one unit | `packages/database/src/sales/schema.ts`; `apps/web/src/sales/purchase-page.tsx` | Integration `sales.test.ts` schema/constraints | [Sale configuration](sale-configuration.md); no auth/payment/catalogue/quantity/history page |
| At most one unit/order per normalized identifier per sale | Redis `sales/admission-script.ts`; database `sales/orders.ts` and unique constraint | Integration `admission.test.ts`, `orders.test.ts`, `invariants.test.ts`; stress final accounting | [Admission](redis-admission.md), [architecture](architecture.md) |
| Trim/lowercase, nonempty, arbitrary identifiers; infrastructure limits | `packages/contracts/src/sales/identity.ts`, `schemas.ts`; API `sales/routes.ts` | Contracts unit tests; integration `api.test.ts`; browser normalization/empty input case | [Public contract](public-contract.md): byte/NUL/body/key bounds are explicit |
| Single page: live upcoming/active/ended/sold out, purchase, duplicate/failure feedback, lookup/polling | Web `sales/purchase-page.tsx`, `use-sale.ts`, `use-order.ts`, `client.ts`; API `sales/routes.ts` | `tests/browser/purchase.spec.ts`, integration `api.test.ts`; human walkthrough below | [Testing UI mapping](testing.md#requirement-to-test-mapping); API/UI label for active is OPEN |
| Atomic time check/reservation/mapping/stream append; Redis execution order | Redis `sales/admission-script.ts`, `admission.ts` | Integration last-unit contention, stream execution order, collisions; invariant suite | [Redis admission](redis-admission.md); fairness is Redis execution order |
| Redis TIME, start inclusive/end exclusive; completion allowed after closing | Redis admission script; worker `orders/consumer.ts` | Integration exact predicate plus real TIME invariants; stress opening/closing/closing-worker-crash | [Architecture](architecture.md#admission) describes clock authority; countdown is informational |
| Same request key replays; new placement for allocated identifier reports already placed | Redis admission script; API routes; web session/submit lock | Integration simultaneous replay and replay after closing; browser double-submit/uncertain retry/duplicate cases | [Public contract](public-contract.md); refresh retrieves by identifier |
| AOF everysec, persistent volumes; local durability before placement acknowledgement | `deploy/redis.conf`, Compose volumes; Redis `sales/durability.ts`, `durability-scripts.ts` | Durability unit/integration tests; failure wrong-connection WAITAOF and before/after fsync SIGKILL | [Durability protocol](admission-durability.md), [failure matrix](failure-matrix.md) |
| Uncertainty never becomes guessed rejection; worker confirms before durable order | Durability fence/checkpoint; API routes; worker consumer; database orders | Integration delayed original admission/absence fencing; failure network reply loss and worker boundaries | [Public contract](public-contract.md): wire uncertainty is NOT_ORDERED/confirmation_uncertain, UI explains uncertainty and permits same-key retry; it does not assert definitive absence |
| Eventual success after recovery/remediation; no expiry/release at internal failure or exhaustion | Redis `sales/retries.ts`; worker consumer; `scripts/recovery.mjs` | Integration `recovery.test.ts`; failure exhaustion/replay/reconciliation/network tests | [Recovery runbook](recovery.md); conditional on intact storage and restored operation |
| Independent API/worker scaling; bounded overload before admission | `packages/operations`; API/worker services; proxy; Compose | Integration `overload.test.ts`, two-API/two-worker invariant; historical stress replica comparisons | [Operations](operations.md), [measured scaling](stress-results.md) |
| Acknowledged work survives API/worker/Redis/PostgreSQL local crash/restart | Persistent volumes, durability gates, idempotent DB transactions, startup reconciliation | `tests/failure/{boundaries,durability,network,recovery,readiness}.test.ts`; integration restart | [Failure matrix](failure-matrix.md); storage loss/host/region redundancy excluded |
| No overselling, duplicate allocation/order, lost ack, false durable ack, infrastructure revocation | Atomic admission + unique SQL order + barriers + retained reservations | Independent raw Redis/SQL/ack invariant suite; deterministic failures; stress accounting | [Integration matrix](integration-coverage.md), [stress invariants](../scripts/stress/README.md) |
| Unit, real-service integration, browser, deterministic failures and boundary tests | `tests`, package/app unit tests, service/stress runners | Final runner executes each suite; browser HTTP is stubbed, real persistence covered separately | [Testing](testing.md), [failure matrix](failure-matrix.md) |
| Five exact bursts: 100/1k unique, 100/10k unique, 100/10k repeated-100, 100/100k unique, 10k/100k unique | `scripts/stress.mjs`, `scripts/stress/{accounting,generator,case}.mjs` | Historical [manifest](evidence/dev19/manifest.json), [summary](evidence/dev19/summary.json); fresh runner attempts all five | **Gap:** last two historical bursts exceed one-second dispatch; target unproven |
| Actual dispatch <=1s; separate response/drain, load boundaries/failures | Generator OS write timestamps, accounting validity checks; `experiments.mjs` | Harness real TCP timing tests; opening/closing/worker-crash/repeated scenarios; failure suite | [Harness guide](../scripts/stress/README.md); invalid attempts remain invalid even if accounting passes |
| Capacity, latency, resources, rejected/uncertain outcomes and eventual accounting | Stress host/config/resource/result artifacts and report tool | Historical compressed raw artifacts and manifest; final-run SHA/logs/checksums | [Stress results](stress-results.md), [testing measured summary](testing.md#measured-summary); missing durability percentiles/physical fsync latency explicitly unmeasured |
| Repository URL, README, diagram, rationale, build/run/test instructions, stress summary | [Repository](https://github.com/inderawaski/bookipi-assessment), [README](../README.md), [diagram](architecture.md), [decisions](decisions.md), [testing](testing.md), [recovery](recovery.md), [stress](stress-results.md) | Relative links, Compose config, build, final checks and fresh checkout rehearsal | Ready for human review; local fresh checkout does not verify a remote push |
| All child criteria and human checkpoints; final review before sending | This audit and receipt/checklist below | Human reviewer must supply evidence and sign-off | **Pending**; no automated or agent execution substitutes for a human |

## Final-commit verification receipt

After committing the reviewed changes, use a fresh local clone of that exact commit. A local clone verifies tracked source completeness without requiring an unpublished commit to exist on GitHub. Record that distinction; push/publish is a separate action.

```sh
# Run from the existing repository; use a new empty destination.
git clone --no-hardlinks . /tmp/flash-sale-submission
cd /tmp/flash-sale-submission
git checkout --detach <final-commit-sha>
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node scripts/submission-check.mjs
```

The runner refuses dirty/untracked source, runs the documented checks sequentially once (stress may retry invalid dispatch using its existing policy), and keeps failures while continuing independent checks. It exits nonzero if any check fails or the source changes. `result.json` records commit/tree, host/runtime versions, stress overrides, exact commands, timestamps, exit codes and human-review=pending. `manifest.json` hashes logs and all failure/stress artifacts in this checkout. Use a fresh checkout so earlier artifacts cannot be mistaken for final-run evidence. Stress artifacts include resolved Compose budgets, persistence settings, host details and per-request accounting.

Results are under `test-results/submission/<SHA>/<UTC-run-time>/`. They are intentionally ignored: a tracked receipt containing its own commit SHA would change that commit. Preserve the entire `test-results` directory alongside the submission and compare hashes with the manifest. Do not amend the verified commit. Any source/configuration fix requires a new commit and new verification. A socket cap may be set explicitly via STRESS_CONNECTIONS/STRESS_MAX_CONNECTIONS; it is recorded and never relaxes the one-second rule. Invalid runs and runner setup errors are submission gaps.

## Fresh-checkout Docker and human walkthrough

Follow [README build/run](../README.md#build-and-run) verbatim in the fresh checkout, using a new Compose project (`COMPOSE_PROJECT_NAME=flash-submission-<unique-suffix>`) and free documented ports. Copy `.env.example`, build, start infrastructure, migrate, and configure a future opening before starting the stack. Use only that disposable project's services; never operate on an existing demo project. Retain its volumes with `docker compose stop`/`start` or `down` without `--volumes`. Record the project, exact configuration/times/stock and revision. Do not change persistence or overload settings to make the demo pass.

| Step | Human action and required evidence | Expected result |
| --- | --- | --- |
| 1 | Open future sale URL; screenshot countdown, status and disabled purchase | UPCOMING; no early allocation |
| 2 | Wait for OPEN; enter ` Demo Buyer! `; double click Buy Now; record request keys/network and displayed order ID | One normalized allocation, one in-memory key; processing then SUCCESS |
| 3 | Deliberately click Buy Now again; refresh page; inspect lookup response | Explicit already-placed feedback and same durable order |
| 4 | Stop only the disposable worker; place a second identifier; save lookup and recovery inspect output | PROCESSING/queued; stock reserved |
| 5 | Stop/start the whole project with volumes intact; wait for readiness then queue drain; refresh both identifiers | Exactly one SQL order per buyer, same first order ID, no replenishment |
| 6 | Run sale:configure again with the original ID/start/end/stock | Existing inventory and orders unchanged |
| 7 | Configure a separate future sale with one unit; buy it; try another identifier | SOLD_OUT; no second allocation |
| 8 | Configure a separate short future sale; allow it to end, then try a fresh identifier | ENDED, purchase disabled; earlier work may finish after closing |
| 9 | Review `pnpm test:failure` exhaustion/repeated replay evidence; follow recovery inspect/replay on exhausted disposable work and observe page | PROCESSING/delayed keeps reservation; manual replay converges once to SUCCESS |
| 10 | Inspect durability before/after confirmation crash traces and real SQL order; compare against duplicate/refresh/restart evidence | Placed acknowledgement is backed by local AOF; SUCCESS by committed PostgreSQL order |
| 11 | Explain actual stress numbers and invalid runs; inspect final receipt and all child checkpoint records | No claim of 100k/s achieved; unresolved items stated before submission |

For step 9 use the isolated test fixture described in [failure matrix](failure-matrix.md), not a new public failpoint or relaxed retry configuration in the demo. Automated traces establish the crash boundary; a human must review them. A live delayed-state demonstration requires disposable exhausted work; merely stopping a worker shows queued, not delayed. Browser double-click tests use stub HTTP, so step 2's live observation complements them.

## Performance explanation and release decision

Historical valid 10k unique dispatch: last write 947.11 ms, 47 eventual orders, 8,975 busy, 21 confirming, 26 queued/delayed, 978 non-JSON proxy responses; p95/p99 response 2,693.43/2,753.62 ms, drain 38.08 s after responses. These percentiles mostly measure saturation responses, not completed-order throughput. Both 100k cases are invalid (16,547.24 ms and 9,292.18 ms last write). See [full results](stress-results.md) for resources, failed attempts and replica comparisons.

Bounded admission protects resource use but leaves stock unfilled under saturation. Everysec AOF barriers add acknowledgement and serial worker latency. More APIs/workers helped the measured small comparison; a single Redis admission authority and ingress/generator limits remain. Stress uses a larger proxy budget than the demo. Distributed generators, admission batching with proven write/wait ownership, worker batching, stronger replication and partitioning are future proposals requiring new correctness/measurement evidence. No max PostgreSQL capacity, disk saturation or regional availability is established.

Final reviewer record (leave pending until supplied by a person):

- Reviewer/date: **pending**.
- Final SHA/tree and final-run receipt directory: **pending human attachment/review**.
- Fresh checkout host, project, commands, screenshots, order IDs, restart/stock/replay evidence: **pending**.
- Child checkpoints A/B/C/D/E/F/G evidence references: **pending**.
- Five prescribed bursts valid/accounted: **not satisfied by historical evidence; inspect fresh receipt**.
- Final decision and acknowledged limitations: **pending**.
- External sending: **not authorized by this ticket**.

## Implementation review

DEV-22 changes only audit documentation and verification tooling. Self-review covered requirement completeness, distinction between historical and final evidence, failed-check propagation, clean-source enforcement, configuration/commit pinning, artifact integrity, secret minimization and isolation. The runner tests cover dirty-source refusal, SHA/settings/checksum receipts, pending human review and continuation after a failed check. Inverting the all-checks-passed condition made the receipt test fail; the original condition was restored and the tests passed. Initial unit execution without localhost permission failed with `listen EPERM`; the unchanged suite passed with socket permission. No application behavior or dependencies changed. Final receipt execution and live Docker rehearsal occur after this commit; their results must be read from the artifacts, not inferred from this review.

The first fresh-checkout run exposed Playwright's default cleanup of the entire `test-results` directory, which removed the in-progress submission receipt and unrelated rehearsal evidence. Browser output is now scoped to `test-results/browser`; the final run verifies that sibling submission/failure/stress evidence remains intact. This test-output isolation changes no purchase behavior. An earlier interrupted attempt also selected Node 24 outside the repository; explicitly select the README's Node 22 runtime before final verification. Preserve failed/interrupted attempts separately from the final receipt.
