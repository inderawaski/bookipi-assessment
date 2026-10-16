# Immediate Redis acknowledgement and one asynchronous replica

> These measurements precede the approved final PostgreSQL stock cap. Review
> reproduced a crash race, then the user approved its fix. See the
> [race and guard](admission-loss-crash-race.md) and
> [final verification](final-stock-cap-results.md). The archived pre-guard result
> remains historical evidence.

Decision approved on 16 October 2026: return PROCESSING when the Redis primary
acknowledges the reservation Lua, without WAITAOF or WAIT. AOF everysec remains
background persistence. One read-only asynchronous replica has its own volume;
API and workers use the primary. Replica outage does not block acknowledgement.
There is no automatic failover and no acknowledged-admission survival guarantee.

This deliberately changes the meaning of PROCESSING. It is provisional Redis
acceptance; SUCCESS is a committed PostgreSQL order. Redis crash/failover can lose
an acknowledged reservation before commit. The browser now handles a successful
fresh lookup that finds no reservation, reports the loss and allows same-key retry.
Unavailable/uncertain lookup cannot erase known state, and SUCCESS never regresses.
A committed order whose Redis metadata was lost still fences new admission for
operator reconciliation rather than risking overselling.

## Implementation and verification

The reservation acknowledgement path issues one admission Lua command after
connection/safety checks. It performs no subsequent confirmation script, persistence
wait or PostgreSQL order lookup before returning. Replay/duplicate responses carry
PROCESSING; the GET order endpoint reports committed SUCCESS. Internal types use
RedisAdmission and ValidatedReservation rather than claiming disk durability.

Workers still validate the current reservation identity, timestamp, mappings and
stream entry. Worker validation, retry claims, configuration, recovery and operator
replay do not wait for persistence/replication. Admission concurrency and HTTP
limits remain unchanged. Demonstration and isolated test Compose both contain one
read-only replica, with separate primary/replica volumes and a replication-link
health check. Both are on one Docker host, not separate failure domains.

Verified: 62 unit tests, 47 integration tests, 22 failure tests, 23 browser tests,
20 harness tests, typecheck, lint, build and Compose configuration. Integration
covers replication, read-only rejection and admission while the replica is offline.
A deterministic older-snapshot simulation covers loss of an acknowledged admission
and safe same-key retry. Redis SIGKILL tests validate fencing and consistency of
whatever state survived; they no longer assert every acknowledgement must survive.
SIGKILL alone generally retains OS page-cache writes, so it does not simulate
power loss deterministically. Existing process/network/unknown-commit tests remain.

As a mutation check, reintroducing WAITAOF into placement fails the immediate-ack
regression; restoring the implementation passes. Archived verification logs and
failure JSON are indexed in the [manifest](evidence/async-admission/manifest.json).
The failure runner retains its own recovery volumes for
`flash-test-1fcf34ff-addc-45f4-8823-0b7d044e50e6` under its existing cleanup policy.

## Healthy spike measurement

Measured 16 October 2026 at approximately 20:23 Asia/Jakarta on the shared Apple
M4 Pro / 24-GiB host. The budget is one API, one worker, one Redis primary, one Redis
replica, PostgreSQL and stress proxy, each with one CPU / 512 MiB. The generator
uses 10,000 preconnected sockets, offers 10,000 unique buyers over 900 ms and
requires every write before one second. Initial stock is 100. No purchases retry.

| Measurement | Result |
| --- | ---: |
| Last request write | 901.55 ms — valid |
| Admissions / committed orders | 100 / 100 |
| Admission-to-committed-order visibility p50 | 198.76 ms |
| p95 | 338.08 ms |
| p99 | 364.76 ms |
| Maximum | 364.76 ms |
| Drain after HTTP responses | 128.02 ms |
| Queued acknowledgements | 100 |
| Explicit busy | 2,629 |
| Explicit sold out | 3,166 |
| HTTP 504 | 4,105 (3,498 connect / 607 response-read timeouts) |

All stock, identity, acknowledgement-preservation and reconciliation checks passed.
The existing healthy-spike gates (p99 < 2,000 ms and every order <= 10,000 ms) passed
without relaxing them. Timing uses first observed committed PostgreSQL visibility,
including approximately 25-ms sampling delay, not the pre-commit completed_at field.

**HTTP overload remains unresolved:** 4,105 requests received proxy 504s: 3,498 connection timeouts and
607 timeouts while waiting for response headers. The test passes its declared stock/order gates because no HTTP error-rate SLO
has been set. This is not an all-request success or production-readiness claim.

The earlier barrier-based baseline measured 43 orders with an 84.6-second p99.
The new result is encouraging, but it is one healthy run, not a durability proof
or a controlled measurement of one code change: worker/retry barriers and the POST
status lookup were also removed, and a Redis replica was added. Shared-host
scheduling/background activity can affect results. The previous full scale-out
matrix is historical; it has not been rerun under this acknowledgement contract.

## Evidence

[Raw result](evidence/async-admission/flash-test-83dabb53-05a3-49be-9211-d60378a724da/spike-10k/result.json.gz),
[summary](evidence/async-admission/summary.json), and
[manifest](evidence/async-admission/manifest.json) retain the workload, responses,
request timings, committed-order observations, reconciliation, resolved Compose,
host metadata, resource samples and service logs. The archive includes an
implementation-source bundle of the working tree. The run used uncommitted changes;
the base commit alone does not describe the tested implementation. No live
production stack was deployed as part of this change.
