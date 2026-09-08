# Concurrency & locking (B2 + B3)

How order/shift mutations behave under contention: what the client sees, what
the database guarantees, and the audited inventory of every lock in the system.

## 1. The client contract: fail fast, retry bounded

Every order-mutating transaction runs at `REPEATABLE READ` with lock-first
row locks (B2). A concurrency loser NEVER waits silently and NEVER returns a
leaked internal: the central `mapPostgresError`
(`src/infrastructure/db/postgres-errors.ts`) translates exactly three
SQLSTATEs into `ConcurrencyRetryableError`, serialized as HTTP 503:

| SQLSTATE | Meaning | Client action |
|---|---|---|
| `40001` | Serialization failure — a rival committed first | Retry the whole operation |
| `40P01` | Deadlock detected — the detector aborted us | Retry the whole operation |
| `55P03` | Lock wait exceeded `lock_timeout` | Retry the whole operation |

The 503 body carries the stable code `concurrency.retryable_conflict`
(`pgCode` preserves the SQLSTATE for operators). The message is constructed
server-side — never echoed pg text — and names retrying. Retry loops MUST
branch on `isConcurrencyRetryableError(error)` (or the stable code), never on
the pgCode, the message, or the status alone.

Everything else passes through the mapper BY IDENTITY (fail-closed): `23505`
unique violations, `23514` trigger rejections, permission denials, connection
failures, and compound `AggregateError`s (operation + `ROLLBACK` both failed —
a 500-class operational incident, never silently retried). Retrying a
non-retryable error is a client bug; the T3 hammer test below fails loudly if
one ever escapes as retryable.

Until B8 lands idempotency keys, a retried operation is a NEW attempt: clients
must re-read state (balance, shift status) before rebuilding the request
rather than blindly replaying the same payload.

## 2. Timeouts: bounded waits everywhere

`withTenantContext` arms two transaction-scoped bounds on every app
transaction (`SET LOCAL`, so pool reuse can never leak them):

- `statement_timeout = 30s` — the backstop: no transaction runs longer.
- `lock_timeout = 5s` (default) — no transaction WAITS on a row lock longer
  than this; the waiter dies `55P03` → retryable 503 instead of piling up
  behind a slow committer.

Engines that need a tighter bound pass `lockTimeoutMs` through their store
(e.g. a collect hammering a hot shift row). The platform-tax wrapper maps the
same triple to the retryable error but sets NO `lock_timeout`: platform admin
writes are low-concurrency by nature, and an idle admin session must never be
surprised by a lock bound — this exception is deliberate, not an omission.

Live proof: `test/integration/concurrency-recovery.test.ts`.

- **T1** holds a shift lock from a second connection and collects with a
  150ms bound: the collect fails in milliseconds with `55P03`, and the SAME
  collect converges once the pile-up clears.
- **T2** inverts the lock order on two orders on purpose: exactly one side
  dies `40P01` (mapped retryable), the survivor commits — no double-commit,
  no double-abort.
- **T3** hammers ONE shift with twelve concurrent collectors (see §5).

## 3. Lock-order audit (B2 uniform order)

**The rule:** in every order-mutating transaction, `SELECT … FOR UPDATE` on
the `orders` row is the FIRST statement; the `shift_reconciliations` row (for
close/collect) is locked SECOND. Uniform order, no exceptions — so same-order
races serialize and different-order work never contends globally. A `revision`
bump on the locked row turns the waiter into a clean `40001` under
`REPEATABLE READ`.

B2 lock sites (all audited, all covered by `test/unit/tools/lock-order-audit.test.ts`):

| File | Row locked | Transaction |
|---|---|---|
| `postgres-orders-store.ts` `lockOrder` | `orders` | creation, transitions, discount, void |
| `postgres-payments-store.ts` `lockOrder` | `orders` | collect |
| `postgres-payments-store.ts` `lockShift` | `shift_reconciliations` | collect (second) |
| `postgres-shifts-store.ts` `lockShift` | `shift_reconciliations` | open/close (orders row first where an order is in scope) |

Pre-B2 single-row locks (audited, each confined to one short transaction over
rows no other transaction locks — no cycle possible):

| File | Row locked | Purpose |
|---|---|---|
| `postgres-auth-repository.ts` | session token (`FOR UPDATE`), `users` (`FOR SHARE`) | login/refresh atomicity |
| `postgres-catalog-repository.ts` | one `menu_items` row | tax edit read-modify-write |
| `postgres-manager-override-authenticator.ts` | one throttle-counter row | PIN attempt counting |
| `postgres-permission-repository.ts` (×3) | `user_roles` rows | last-super-admin guard |
| `postgres-tenant-tax-admin-repository.ts` | one tax-mapping row | assignment upsert |
| `postgres-orders-store.ts` `claimSideEffect` | one `side_effect_delivery_log` row | outbox claim-then-execute |

Function/trigger locks inside migration SQL (also allowlisted — executable
statements only, comments stripped):

| Migration | Row locked | Fired by |
|---|---|---|
| `0010` | one `tax_rates` row | rate-admin function |
| `0015` | parent `branches` row (`FOR SHARE`) | override trigger |
| `0016` (×4) | `menu_items` / `branches` / `tenants` rows | tax-assignment functions |
| `0040` = `0042` = `0043` | one `inventory_items` row | stock-movement trigger — the X-side of finding F-1 (§4) |

Negative inventory (also pinned by the audit test): NO advisory locks
(`pg_advisory_*`) anywhere in `src/`; NO `LOCK TABLE` in production code. The
single `LOCK TABLE` in `0013_phase6_branch_country_not_null.sql` is
migrate-time DDL serialization, never runtime SQL.

One honesty note: row locks ALSO arise from plain `UPDATE`/`DELETE` (the B2
revision bumps, the `recompute_order_status` trigger cascade, the
`order_event_sequence` bump) — no `FOR` clause, same lock. The allowlist pins
the EXPLICIT `FOR`-clause sites; the orders-row-first ORDER rule above governs
every lock-shaped statement, spelled or not.

**Any new lock — or reworded lock line — fails the audit test until this
document and the test's allowlist are extended in the same commit.**

## 4. Known findings (documented, not hidden)

- **F-1 — creation/void lock-order inversion (RESIDUAL, rare).** Order
  creation appends the initial status event (locking the per-branch
  `order_event_sequence` row) BEFORE the stock-deduction trigger fires, while
  void paths lock the stock rows first — an S→X vs X→S inversion. It needs a
  creation and a void on the SAME branch to overlap inside the trigger
  cascade; PostgreSQL detects the cycle and aborts one side with `40P01`,
  which B3 maps to the retryable 503. Deliberately NOT reordered in B3:
  touching the event-sequence/trigger cascade risks the gapless 1..N
  per-branch numbering the sequence row exists to serialize. Backlog: revisit
  if `40P01` telemetry ever shows this pairadjacent.
- **Fix-J rule — never hold an orders lock across the void challenge
  (HARDENED, proven by a 120s hang).** The manager-override challenge writes
  an `attempts` row whose FK check takes `FOR KEY SHARE` on `orders`; holding
  `FOR UPDATE` across that nested transaction deadlocks the FK checker in a
  way the detector cannot see (one side JS-awaits while DB-blocked). Void
  paths therefore run the challenge FIRST and lock + bump the order row only
  after it succeeds. Any future nested-transaction feature must obey the same
  rule: locks are leaf-level, never held across a sub-transaction.

## 5. Per-branch ceiling (what T3 proves, and what it means)

T3 (`concurrency-recovery.test.ts`) is the executable ceiling: 4 orders × 3
partial collects (20.00 + 20.00 + 6.00 = 46.00 — every interleaving fits, so a
retry can never mask a balance error) hammer ONE shift concurrently. All
twelve converge with per-collect retry budgets of 25 attempts, every order
ends EXACT (3 payments, SUM 46.00, `payment_status = 'paid'`), and the test
fails if ZERO retries happened (a contention test that never contends is
vacuous).

Operational reading:

- Contention serializes per order + shift row, never globally: adding shifts
  (or branches) adds throughput linearly; a single shift absorbs a lunchtime
  rush by retrying, not by queueing callers past the 5s lock bound.
- `deadlock_delay` (≈1s default) bounds 40P01 detection; `lock_timeout`
  (5s default) bounds pile-ups; `statement_timeout` (30s) bounds everything.
  A client retry budget of ~25 attempts with jittered backoff is generous
  against all three.
- Telemetry to watch: `concurrency.retryable_conflict` rate per branch (a
  climbing rate means the shift row is hot — open a second till), and any
  `40P01` mentioning `order_event_sequence` (finding F-1 knocking — see §4).
