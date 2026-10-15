# Admission durability protocol (DEV-10)

Redis is pinned to **7.4.8**, AOF everysec, noeviction, persistent storage. Guarantees assume intact storage and correct fsync behavior. `admitPurchase` returns internal, potentially volatile reservation evidence only. API placement must use `DurableAdmission.place`; identifier lookup must use `lookup`; workers must obtain `confirmForWorker` evidence matching the message request key and stream ID before their PostgreSQL transaction. No worker order writer or public purchase route exists yet (DEV-11/DEV-13).

## Confirmation

1. Take a concurrency slot before connecting. Each operation gets a distinct socket with offline queue and automatic reconnection disabled.
2. Check persistence configuration and AOF write health. Atomically check the recovery fence and execute admission Lua, or locate the normalized identifier for lookup.
3. Validate reservation, both associations and the exact stream entry. Increment a confirmation checkpoint on **that socket**, including for replay and different-key duplicates.
4. Run `WAITAOF 1 0 <deadline>` on the same socket and require local result exactly `1`. Only then return queued placement, duplicate with queued existing order, or worker evidence.
5. Timeout, malformed result, connection loss, persistence failure or recovery fence means PROCESSING/confirming. A worker retains its message/reservation and cannot finalize. Never release stock on infrastructure failure.

There are 16 concurrent sockets per gate by default, batch size **one**, no waiting queue, and a 3000 ms deadline covering connect, validation, writes and wait. Each socket is destroyed after the operation. A blocked wait cannot serialize all clients. Saturation produces busy before admission; lookup remains confirming. These conservative defaults prioritize a reviewable protocol; throughput tuning belongs to the load/overload tickets. API and worker processes need separate gate instances.

Redis 7.4.8's [WAITAOF implementation](https://github.com/redis/redis/blob/7.4.8/src/replication.c#L3277-L3313) compares `server.fsynced_reploff` to **the calling client's** `c->woff`. A new connection's wait alone does not confirm another client's admission. The checkpoint advances the lookup client's offset after the earlier Lua reservation and stream writes. Confirmation of this newer global AOF prefix therefore covers both. The real-service proof suppresses fsync: unrelated wait returns `[1,0]`, writer wait `[0,0]`, lookup checkpoint then wait `[0,0]`; restoring everysec lets confirmation succeed. No replica quorum is claimed.

## Missing identifiers and delayed requests

A missing identifier never becomes NOT_ORDERED or REJECTED automatically: an old API request might still execute. Lookup returns `confirming/missing_without_absence_proof`, including after recovery. No public attempt ID or durable negative-outcome claim is introduced. The executable delayed-admission test observes missing, then executes the old admission and finds a durable reservation; the earlier lookup never falsely rejected it. Business rejections from a completed admission script describe that submission only, consistent with the existing retry contract.

## Restart and recovery

Admission Lua and confirmation compare the sale's persisted `recovered_run` to Redis's current `INFO server` run_id inside Lua. Restart changes run_id, fencing all admissions and worker confirmations immediately, even if the old fence value survived. Service startup/readiness reconnects, validates immutable PostgreSQL sale configuration, reads that sale's complete DB order snapshot and calls recovery before marking the new run recovered.

Recovery atomically closes the fence, verifies `initial = remaining + retained reservations`, validates every identifier/request/reservation association and exact stream entry, and checks every DB order has a matching reservation and admission timestamp. Pending and completed reservations remain retained; stream entries must remain retained too. Only valid accounting reopens the fence, followed by a local AOF barrier. Every placement still has its own barrier, so an operation interleaving before recovery's wait cannot bypass durability. A mismatched DB order, missing stream entry, expiry, or fault latch leaves the sale unavailable for operator repair. Recovery never adds stock or reconstructs it from DB counts. Scanning is an operator/startup operation proportional to retained allocations, not a hot-path request.

No external caller may clear fences, trim streams, expire allocation keys or call recovery with an incomplete DB snapshot. Future worker cleanup/retry work must preserve this retention invariant or explicitly replace the recovery protocol. A previously confirmed worker token remains valid across restart because its reservation and stream prefix already fsynced; a token is local evidence, never accepted from HTTP or serialized as authority.

## Executable evidence and checkpoint B

- `pnpm test:unit`: owning-connection sequence, exact local count, Lua/checkpoint/wait disconnects, bounded capacity, deadline, persistence refusal.
- `pnpm test:integration`: replay and duplicate confirmation, cross-connection checkpoint, worker message identity, pending stock accounting, invalid DB/stream recovery, delayed old request and conservative missing lookup.
- `pnpm test:failure`: real fsync suppression and wrong-connection regression; SIGKILL before Lua, after Lua, during a verified blocked WAITAOF, after confirmation before a simulated HTTP response, and following AOF rewrite. Restart must fence first; acknowledged work must remain discoverable; unacknowledged work may be present or missing but never guessed rejected.

The failure tests stop actual Redis processes; transport-boundary unit tests model API socket loss. HTTP routes are not present yet, so HTTP loss is simulated at the library boundary. An OS-process kill does not simulate power loss or a lying storage device. Broader network/load failures remain DEV-17 work. Checkpoint B requires human inspection of this protocol and test output before broader feature work; implementation does not record human approval on the reviewer's behalf.

DEV-17 adds process failpoints, real TCP reply loss/partition, unknown PostgreSQL
commit results, worker crash/replay and retained evidence. The current coverage and
human checkpoint E instructions are in [the failure matrix](failure-matrix.md).
