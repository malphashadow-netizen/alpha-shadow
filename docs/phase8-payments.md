# Phase 8 — Payments (نظام الدفع)

The spec is final and locked. This document maps the locked spec to what is
implemented, so the code can be audited against it. Everything here is
enforced twice whenever possible: once in the application engine, once
structurally in PostgreSQL (CHECKs, triggers, generated columns, partial
unique indexes, FK RESTRICT).

## The binding pseudocode (Section 2), step by step

| Step | Where |
| --- | --- |
| 1. `subtotal = Σ active line amounts` | `computeOrderTotals` (`order-totals.ts`), re-verified by `validate_order_discount` (0034) |
| 2. requested discount value parsing (NUMERIC(18,4) semantics) | `parseDiscountRequest` (`discount-math.ts`) |
| 3. `applied = MIN(requested, remaining subtotal)` — capping can NEVER go negative | `computeDiscountStage` + `validate_order_discount` CHECK |
| 4. escalation decision: cap exceeded OR zeroing out ⇒ live manager override (Phase 7b, unmodified) | `discountOverrideRequirement` + `DiscountEngine.applyDiscount` |
| 5. stacking coupon → manual → points, each against the CURRENT remainder | `applyDiscountStages` (pure) + `DiscountEngine` per-row ledger writes; DB gate = `enforce_discount_stacking` |
| 6. tax recomputed on the DISCOUNTED bases | `computeOrderTotals` replays `order_line_tax_snapshots` through the Phase-6 cascading engine |
| 7. `total = discounted subtotal + exclusive tax` | `computeOrderTotals` (inclusive taxes stay inside the price) |
| 8. `remaining = total − Σ completed payments` | `computeOrderTotals`; `recordPayment` fails closed on `PaymentExceedsBalanceError` |

### Discount allocation across lines (step 6 detail)

The applied discount total is allocated across the ACTIVE lines
proportionally to their amounts (largest-remainder, stable by line id), and
each line's immutable rate/inclusivity/cascade-priority snapshot is replayed
against its reduced base. Only EXCLUSIVE taxes enter the total.

## Money rules (locked)

* `payments.amount_in_base_currency` is **NET of change**: it is the figure
  that counts toward the order balance AND toward `recorded_cash_sales`.
* Change is ALWAYS given in the branch base currency, and only on
  `cash` / `foreign_currency_cash` methods (`validate_payment`, 0035).
* Foreign-currency cash uses the method's MANUAL fixed rate (no live FX API —
  deferred by the spec). The rate used is frozen per payment in
  `payments.exchange_rate_snapshot` (immutable after insert), and every change
  of the method's rate is appended to the tenant's `exchange_rates` ledger by
  the `payment_methods` trigger (0033).
* Payments never exceed the remaining balance (engine fail-closed).
* Percentage discounts are stored at NUMERIC(18,4) precision
  (`dbps` internally); amounts at NUMERIC(18,2) minor units.

## Manager-override evidence is context-scoped (locked)

Every Phase-7b live challenge attempt records its business context —
`'void'` (Phase 7 order/item voids) or `'discount'` (Phase 8 discount
escalations) — on `manager_override_attempts.context_type` (migration 0036;
pre-Phase-8 rows are backfilled as `'void'`, and the default is then dropped
so every insert states its context explicitly). Evidence can never cross
contexts: `findSuccessfulOverrideAttemptId` filters by context, and the
database (`validate_order_discount`, upgraded in 0036) accepts only a
SUCCESSFUL **discount-context** attempt of the same actor and order as a
discount row's override evidence.

**Deliberate**: the rate-limiting lockout state
(`manager_override_lockout_state`, `manager_override_actor_lockout_state`)
does NOT record context and stays in force ACROSS ALL CONTEXTS per manager
and per initiating actor — otherwise an active lock could be bypassed by
alternating between Void and Discount challenges.

## Discount authority (locked)

* The atomic sensitive permission key is `order:discount:apply`
  (0031). The approving manager of an override must PERSONALLY hold it.
* Per-user caps live in `user_discount_limits` (percentage / fixed amount).
  A NULL cap dimension means the kind is NOT granted — an override can raise
  a SET cap but can never MINT authority that was never granted
  (`validate_order_discount`).
* The cap gate is DUAL-dimension: besides the request's own dimension
  (`exceeds_matching_cap`), when the OTHER dimension is granted its
  equivalent is also checked — the percentage's amount equivalent
  (`remaining × dbps`, half-even) vs the fixed cap, or the fixed amount's
  percentage equivalent of the SAME current remaining subtotal vs the
  percentage cap (`exceeds_cross_equivalent_cap`). A 45%-equivalent fixed
  discount is not a 15% discount, whatever shape it was typed in. A
  non-positive remaining subtotal escalates immediately, before any
  conversion arithmetic. Applies without exception to manual and coupon
  mechanisms (both flow through the same kind/value).
* Zeroing out the subtotal ALWAYS escalates, even when the value is inside
  the actor's caps.
* The discount engine does a pre-pass read transaction, then the Phase-7b
  live PIN challenge OUTSIDE the write transaction (the challenge commits its
  own evidence), then a FRESH re-computation inside the write transaction —
  if the order grew in between and now demands un-challenged escalation, it
  fails closed.
* `mechanism='points'` (loyalty) is reserved vocabulary, deliberately
  deferred: `LoyaltyPointsDeferredError`, never a silent zero.

## Shifts (locked)

* `shift_reconciliations` is born `open` only, atomically with its open cash
  count (`cash_count_details`), after DUAL verification — one person can
  never hold both the opener and the verifier role (CHECK), at open AND at
  close.
* One standing OPEN shift per cashier (partial unique index).
* The Z Report (`closeShift`) is the ONLY official close and the only writer
  of the close columns: `counted_cash` from the close count,
  `recorded_cash_sales` = SUM of completed cash payments on the shift
  (re-verified structurally by the upgraded `validate_shift_reconciliation`),
  `variance` is a GENERATED column (`counted − float − recorded`),
  `variance_type` from its sign. After the close the row is immutable and the
  counts are append-only evidence.
* The X Report (`xReport`) is READ ONLY: no writes, no resets; it returns the
  live row, its counts and the live cash-sales/variance figures.

## The shift gateway (locked)

* Order creation REQUIRES `cashierUserId` holding a standing OPEN shift at
  the order's branch (`CashierShiftRequiredError` otherwise).
* Every payment lands on that cashier's open shift (`validate_payment`
  re-verifies: open shift, same branch, creator IS the cashier).
* Payment lifecycle changes (void/refund) are only allowed while the shift is
  still open — a closed shift's Z-Report numbers are final.

## Payment lifecycle (locked)

* `completed → voided` (full void evidence triple, `payments:void`) — the
  order REOPENS for re-collection.
* `completed → refunded` (`payments:refund`, the spec-mandated SENSITIVE key;
  refund evidence lives in `audit_log` because the spec's column list has no
  refund columns).
* Both terminal. Amounts, links, snapshot and creator are immutable; rows are
  never deleted. An order is `refunded` only when EVERY payment is refunded.
* The full Phase-7 sequence now works end to end:
  pay → **Void Payment** → order reopens → Phase-7 item/order voids allowed →
  re-collection. The Phase-7 `PaymentReversalRequiredError` placeholder
  remains the fail-closed answer while an order is `paid`.

## Check splitting (locked, display-only)

* `orders.split_people_count` — display-only metadata, never enters money
  math.
* `order_items.split_group_id` — a light grouping TAG, frozen with the rest
  of the purchase snapshot. Independent sub-invoices are deferred (Section 4).

## Deliberately deferred (Section 4 — out of scope)

Loyalty points, independent sub-invoices, a live FX API, and the
third-party-funded discount exemption.

## Where the tests are

* `test/unit/shared/decimal-text.test.ts`, `test/unit/application/payments/discount-math.test.ts` — pure math.
* `test/integration/phase8-payments.test.ts` — 20 live-acceptance tests on a
  dedicated tenant against real PostgreSQL (RLS, triggers, deferred
  constraint triggers, FK RESTRICT), covering the spec's mandated invariants
  #1–#8 plus the gateway, FX, lifecycle, Z/X reports, coupons and the
  Phase-7×8 void sequence.
