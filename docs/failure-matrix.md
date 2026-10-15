# Deterministic recovery evidence

Run `pnpm test:failure` with Docker available. The runner creates an isolated
`flash-test-UUID` project, builds all services, and retains PostgreSQL and Redis
volumes when removing containers. It never deletes storage in a recovery case.
Successful boundary/network cases write traces and accounting evidence under
`test-results/failure/PROJECT/`. Vitest reports the remaining assertion evidence.
To remove retained volumes after inspection, explicitly run
`docker volume rm PROJECT_postgres-test-data PROJECT_redis-test-data`.

Failpoints are constructor/function callbacks, require `NODE_ENV=test`, and are
never wired by service entrypoints or exposed as routes. A child reports a boundary
over IPC and blocks; the parent waits for that exact event before SIGKILL. No sleep
is used to guess when a process reached a boundary. TCP proxies forward a real
command and discard the server reply, either disconnecting or withholding data
until the client's deadline. The commit-loss case proves the row exists despite
an error at the caller. Checked-out PostgreSQL clients handle socket error events
while query promises still reject; an unknown COMMIT result cannot terminate the
worker process through an unhandled EventEmitter error.

| Boundary / failure | Automated case | Recovery evidence |
| --- | --- | --- |
| Admission before send | boundaries: admission/before_send | Retry allocates once |
| Sent, response lost | network: redis_reply, redis_partition | PROCESSING/confirming, retry finds allocation |
| After admission, before AOF barrier | boundaries: after_send, before_durability | Replay converges |
| After AOF barrier, before caller response | boundaries: admission/after_durability | Acknowledged reservation retained |
| Redis killed before Lua, after Lua, during barrier, after confirmation | durability | Epoch fence, unknown absence, accounting |
| AOF rewrite overlap | durability: rewrite | Slow RDB-preamble key writes with Redis test knob; assert rewrite active before SIGKILL |
| Barrier timeout | durability: unrelated WAITAOF | No durable acknowledgement; later confirmation |
| Worker receipt / durability | boundaries: receipt, after_durability | Pending entry reclaimed, no early DB row |
| Transaction start / transaction / precommit | boundaries: before_transaction, after_begin, before_commit | Rollback after SIGKILL, replay once |
| DB committed, result unknown | network: commit_reply | Real lost COMMIT reply, row retained, idempotent retry |
| Worker after commit / before status / after status / after ack | boundaries | SIGKILL, one order, completion repaired, no pending work |
| PostgreSQL SIGKILL / restart | network: postgres_restart | Pending reservation survives, order completes |
| Retry exhaustion / repeated replay | recovery | Finite attempts, no stock release, replay twice is safe |
| Reconciliation interruption / missing stream / completion repair | recovery | Fenced validation, repeatable repair |
| Dependency disconnected / missing record | readiness, boundaries, network | Unavailable readiness, confirming rather than guessed rejection |

Boundary cases verify one unique order, one reservation/stream entry, zero remaining
stock, zero pending entries, matching completion, and repeated definitive sold-out
rejection with no late allocation. Network cases check the same final accounting.
Redis crash cases additionally check restart fencing and retained durable admissions.
Pending reclamation in boundary tests uses XAUTOCLAIM with zero idle time after
confirmed process death; production retains its 60-second safety interval.

Human checkpoint E remains **pending**. A person must inspect this matrix and the
saved evidence and reproduce at least Redis crash during confirmation
(`pnpm test:failure -t 'during_wait'`) and worker crash after DB commit
(`pnpm test:failure -t 'SIGKILL worker at after_commit'`). Automated execution does
not record human approval.

Verification for DEV-17: 26 failure cases passed with no unhandled errors; 40
integration tests and 67 unit tests passed. Workspace build, lint and type checking
passed. The production failpoint guard test also failed under an intentional
inverted-guard mutation, then passed after restoration. Final failure evidence is
in `test-results/failure/flash-test-1a390b94-c86c-4a7b-ab91-e99d1eb9a79a/`;
the same project's two persistent volumes are retained locally. Generated evidence
is ignored by Git; rerun the suite to produce a fresh report on another machine.
