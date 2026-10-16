# Redis-only purchase admission

> This report records the Redis-only POST revision before the follow-up [sale metadata cache](sale-configuration-cache.md). Its spike evidence is preserved unchanged.

The checkpoint before this change is `ca86e91`. It includes immediate Redis
acknowledgements, the PostgreSQL final stock cap, one asynchronous Redis replica
and all preceding stress evidence. The unrelated macOS `.DS_Store` was excluded.

## Change and rationale

Purchase POST previously scanned PostgreSQL sale configuration and ran a
PostgreSQL/Redis readiness and reconciliation probe before admission. Rejected
buyers could therefore compete with the worker for database resources. The
purchase route now performs input validation and calls RedisAdmission.place
without any PostgreSQL query or reconciliation probe.

Sale configuration was already preloaded into the Redis admission hash by
sale:configure before opening. The existing Lua script checks configuration
version and numeric fields, the current primary's recovered epoch, fault/TTL/type
fences, Redis-time sale window, stock and duplicate/idempotency associations.
These checks and reservation/stream writes remain atomic. No second cache,
expiration policy or Lua duplication was introduced. Startup/health reconciliation
and GET sale/order reads continue using PostgreSQL outside purchase admission.

A prepared sale can admit during a PostgreSQL outage, retaining a provisional
reservation until processing resumes. Health readiness still depends on both
services; infrastructure using readiness may withdraw that API. Missing or corrupt
Redis state fails closed with the existing NOT_ORDERED/confirmation_uncertain
response rather than consulting PostgreSQL or recreating inventory. Consequently
unknown sale IDs on POST also receive that response; GET retains definitive 404.
Redis restart/fault fences, accepted acknowledgement-loss risk and the final
PostgreSQL stock cap remain in effect.

## Verification

The route regression first failed against the checkpoint because PostgreSQL
unavailability prevented admission. After the change it passes and asserts zero
database or readiness-probe calls. Real integration tests admit with the API's
PostgreSQL pool closed and with every pool connection held; they retain Lua
stock, duplicate, malformed-configuration, fault and stale-primary-epoch checks.
Existing real-Redis window, recovery, crash and final-cap coverage also runs.

Checks passed: 65 unit tests, 49 integration tests, 22 crash/network tests,
typecheck, lint and build. Review covered the purchase call path, missing-state
behavior, configuration lifecycle, restart fencing, final stock cap and updated
contract/tests. The previously observed polling serialization error and Nginx
availability issue are separate findings; no proxy or polling changes are included.

## Same-workload spike follow-up

Both fresh isolated runs used 100 stock, 10,000 unique buyers and 10,000
preconnected sockets with a one-second write window. APIs, worker, PostgreSQL,
Redis primary/replica and proxy retained one CPU / 512 MiB per service. The proxy,
timeouts, acceptance gates and worker count stayed unchanged. Tests ran
sequentially after integration/failure suites finished; there was over a minute
between the first burst's last recorded response/poll and the second dispatch.
This does not eliminate shared-host variability.

| Measurement | New 3/1 | New 6/1 |
| --- | ---: | ---: |
| Started UTC, 16 October 2026 | 16:56:04 | 16:57:51 |
| Last request write | 902.37 ms | 900.94 ms |
| Admissions / committed orders | 100 / 100 | 100 / 100 |
| Admission-to-committed-order visibility p50 | 1,107.41 ms | 1,982.50 ms |
| p95 | 1,576.19 ms | 3,894.73 ms |
| p99 | 1,630.15 ms | 3,948.46 ms |
| Maximum | 1,630.16 ms | 3,977.20 ms |
| Busy | 3,019 | 8,618 |
| Sold out | 5,660 | 1,282 |
| Purchase HTTP 504 | 1,221 | 0 |
| Overall | measurement_failed | failed order p99 gate |

Both dispatched validly, admitted all 100 buyers within the first second, committed
every acknowledged admission exactly once, conserved stock and drained pending
entries. New 3/1 passed every recorded stock/order gate but the final proxy-routed
GET /metrics failed with `no live upstreams`; direct metrics from all three APIs
succeeded. Its purchase timeouts were 941 upstream connection and 280 response-read
timeouts. New 6/1 completed measurement successfully and had no purchase or polling
errors, but failed p99 < 2,000 ms; all other recorded invariants passed.

The last pre-change 3/1 result had 717-ms p99 and 190 purchase 504s; pre-change 6/1
had 3,825-ms p99 and no purchase gateway errors. New 3/1 API database pools each had
one connection after the burst, compared with ten each in that preceding baseline.
Removing request-side database access therefore removes that dependency and its
pool demand, but these runs do not demonstrate a latency improvement. In
particular, 6/1 still had approximately four-second p99. The earlier hypothesis
that API PostgreSQL reads explain the scaling slowdown is not established; they
cannot be its sole cause now that the same symptom occurs without them.
Worker stage timings, Redis/network round trips and shared-host scheduling remain
unisolated. No further architecture/proxy/worker changes were made to hide the
failed spike gates.

Evidence: [3/1 summary](evidence/redis-only-admission/3api-summary.json),
[6/1 summary](evidence/redis-only-admission/6api-summary.json), and
[manifest](evidence/redis-only-admission/manifest.json). The manifest includes raw
request records, visibility observations, resolved configuration, host/resource
samples, service logs, runner output, regression red/green logs, verification logs
and a complete implementation/test source bundle. These runs used an uncommitted
change on checkpoint ca86e91; the source bundle identifies the measured revision.
Earlier spike evidence remains unchanged.
