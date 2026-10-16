# Approved final stock protection after admission loss

The requested immediate Redis acknowledgement and one asynchronous replica are
implemented and tested. Review also reproduced a new crash-recovery race that
is broader than losing an acknowledged request: **two PostgreSQL orders can
commit against one unit of stock**.

## Reproduction

1. Stock is one. Redis acknowledges buyer A; its worker inserts an order and pauses
   immediately before COMMIT.
2. Model Redis restoring an older consistent snapshot without A's reservation.
3. Recovery reads PostgreSQL before A commits, sees no completed order and reopens
   admission with one available unit.
4. Redis acknowledges buyer B. B's worker commits an order.
5. A's original transaction commits. PostgreSQL has two orders for different buyers.

The existing UNIQUE(sale,identifier) constraint only prevents duplicate orders for
one buyer. Redis epoch fencing cannot cancel an already-started PostgreSQL
transaction. An asynchronous replica does not close this race.

The isolated regression failed its no-oversell assertion with **stock=1, orders=2**.
It deliberately models restoration of an older Redis snapshot; it is not a claim
that every Redis SIGKILL loses data. See the
[trace](evidence/async-admission/crash-race.json) and compressed
[test log](evidence/async-admission/crash-race.log.gz).

## Approved fix (16 October 2026)

The user approved a defensive final stock cap inside the existing PostgreSQL order transaction. The implementation uses:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT initial_stock FROM flash_sale WHERE id = $1 FOR UPDATE;
-- Return the existing matching order for an idempotent replay.
SELECT id, admitted_at FROM "order"
  WHERE flash_sale_id = $1 AND user_identifier = $2;
SELECT count(*) FROM "order" WHERE flash_sale_id = $1;
-- Refuse a NEW order if count >= initial_stock; preserve conflict evidence.
-- Otherwise insert the order and commit while still holding the sale-row lock.
COMMIT;
```

All application final writers take the same per-sale lock. Redis acknowledgement stays
immediate, with no WAITAOF/WAIT or additional synchronous admission database work.
No table or schema migration is needed. PostgreSQL finalization is serialized
per sale, so its latency/throughput is remeasured after verification. Replays of existing
orders must still succeed at full capacity. A conflicting replacement reservation is quarantined; the worker sets
`admission_fault=committed_order_capacity`, fencing new admissions for operator
reconciliation. It does not insert an extra order or release stock.

This expands the finalization architecture beyond the original admission-loss
trade-off. Following the project's architecture approval boundary, the user
explicitly selected “Add the final stock cap (recommended)” on 16 October 2026.

The permanent integration regression now covers the original interleaving, the
single committed order, full-capacity replay, pending/quarantined replacement and
admission fence. The older failed trace is retained as before-fix evidence. See
[final verification and spike results](final-stock-cap-results.md).
