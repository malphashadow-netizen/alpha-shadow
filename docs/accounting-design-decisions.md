# Accounting Design Decisions

## DD-003 — Revenue recognition point

### Context

The current system records several distinct business times but does not select
an accounting recognition point. `orders.placed_at` records order creation,
`order_item_status_events.created_at` records item workflow transitions,
`payments.created_at` records collection, `orders.closed_at` records order
closure, and `shift_reconciliations.closed_at` records shift closure. These
events are not economically interchangeable: payment may precede or follow
fulfilment, and shift closure is a cash-control event rather than necessarily a
sale event.

The sale amount is currently derived rather than stored on `orders`:
`order_items.unit_price_minor * order_items.quantity` supplies the original
active-line subtotal, `order_discounts.discount_amount_applied` supplies the
applied discount, and the immutable records in `order_line_tax_contexts` and
`order_line_tax_snapshots` supply the tax context and rate evidence used to
recompute tax on discounted line bases. `payments.amount_in_base_currency`
supplies collected value, but collection alone does not decide when revenue is
earned.

### Options

1. **Order creation (`orders.placed_at`).** Recognize revenue when the order is
   created. This is early and deterministic, but requires later item voids,
   cancellations, price-affecting discounts, and unfulfilled orders to produce
   accounting adjustments or reversals.
2. **Item completion (`order_item_status_events.created_at`).** Recognize each
   item's revenue when it reaches a configured completion state. This follows
   fulfilment more closely and permits partial recognition, but requires an
   accounting definition of "completed" that cannot be inferred from a role
   name or mutable display label, plus allocation of order-level discounts and
   invoice-total tax across items.
3. **Payment (`payments.created_at`, for `payments.status = 'completed'`).**
   Recognize revenue on collection. This aligns naturally with cash-basis
   reporting, but conflates settlement with performance and needs explicit
   customer-deposit/deferred-revenue treatment whenever payment precedes
   fulfilment.
4. **Order close (`orders.closed_at`).** Recognize the complete sale when the
   order closes. This provides an order-level finalization boundary, but the
   current schema does not define accounting closure semantics or guarantee
   that all price, discount, tax, and payment evidence is final at that moment.
5. **Shift close (`shift_reconciliations.closed_at`).** Recognize sales during
   the Z-report close. This supports batched posting and cash reconciliation,
   but delays recognition, couples non-cash sales to a cashier shift, and loses
   a natural per-order posting boundary unless detailed source links are
   retained.

Each option must separately define treatment of unpaid, partially paid,
over-time, voided, and reopened orders. A hybrid is also possible—for example,
recognition at item or order completion and separate cash/clearing entries at
payment—but it is a separate choice, not an implied default.

### Additional data required for future implementation

Depending on the selected option, implementation may require:

- an immutable `recognized_at`/`accounting_date` and recognition status or
  event on the order or individual order item;
- a stable, data-driven marker identifying which workflow state constitutes
  accounting completion, rather than a hardcoded role or state-name check;
- an immutable order financial snapshot containing original subtotal, applied
  discount, taxable bases, inclusive and exclusive tax, total, currency, and
  rounding allocations at recognition time;
- `journal_entries` and `journal_entry_lines` carrying unique source-event
  identifiers so retries and later state transitions cannot double-post;
- explicit customer-deposit/deferred-revenue data if payment can precede the
  selected recognition point; and
- a reversal or adjustment link when recognized orders or items are later
  voided, refunded, or reopened.

Any tenant-scoped accounting tables must retain tenant isolation and forced
RLS, and all application money arithmetic must remain in integer minor units
using `BigInt` through the existing money boundary.

### Status

**مؤجل.** No recognition point or hybrid policy has been approved.

### What future implementation must not assume

- It must not assume that order creation, payment, order close, or shift close
  is the revenue-recognition event merely because that timestamp already
  exists.
- It must not treat a completed payment as proof that revenue has been earned,
  or an unpaid order as proof that no revenue has been earned.
- It must not infer accounting completion from a workflow state's display name
  or from a user's role name.
- It must not reconstruct a historical recognized amount from mutable current
  configuration when an approved immutable financial snapshot is required.
- It must not post more than once for the same source event.

## DD-004 — Accounting treatment of Void and Refund

### Context

Payment lifecycle evidence currently lives in `payments`. A payment begins as
`payments.status = 'completed'` and may move to terminal `voided` or `refunded`.
For a void, `payments.voided_by`, `payments.voided_at`, and
`payments.void_reason` form the in-row evidence. For a refund, the table has no
`refunded_amount`, `refunded_by`, `refunded_at`, or refund transaction row;
refund evidence is recorded separately in `audit_log`. The immutable original
amounts remain in `payments.amount`, `payments.amount_in_base_currency`,
`payments.exchange_rate_snapshot`, and `payments.change_given_amount`.

The order-level `orders.payment_status` can be `open`, `paid`,
`refund_pending`, or `refunded`. Item/order void evidence and reasons are held
outside `payments` in the order-void tables and status-event ledger. Therefore
a void of fulfilment, a void of tender, and a refund of settled money are
different source events even when an application workflow coordinates them.

The current payment shape can represent a full terminal reversal of one
payment, but it cannot by itself represent a partial refund, multiple refunds
against one payment, refund fees, a refund in a different amount or currency,
or the settlement identifier of money returned to the customer.

### Options

1. **Reverse the original journal entry.** Create an immutable reversal linked
   to the original entry and preserve the original accounting date. This makes
   correction lineage explicit, but posting into a closed period may be
   prohibited and later-period reporting needs a defined adjustment policy.
2. **Post a reversal on the Void/Refund event date.** Preserve the original
   entry and recognize the reversal at `payments.voided_at` or a new immutable
   refund timestamp. This respects period close, but prior-period revenue and
   tax remain historically reported until the later reversal.
3. **Use dedicated return/refund accounts on the event date.** Debit sales
   returns/allowances or another contra-revenue account rather than directly
   reversing revenue. This improves gross-sales reporting but requires an
   approved account mapping and explicit treatment of tax, discounts, payment
   clearing, and fees.
4. **Different policies for Void and Refund.** Treat a pre-settlement void as
   cancellation/reversal of tender evidence, while treating a post-settlement
   refund as a new financial event. This best reflects different economics but
   requires a reliable settlement boundary that the current schema does not
   store.

Every option must state whether the accounting reversal covers only the tender
entry or also revenue, discounts, tax liability, inventory, and COGS. It must
also decide whether the original transaction date or the actual reversal date
controls the accounting period; neither is implied by the current lifecycle.

### Additional data required for future implementation

Future support may require:

- a dedicated immutable `payment_refunds` table with `tenant_id`, `payment_id`,
  `amount_minor` or exact currency-scaled amount, currency,
  `amount_in_base_currency`, exchange-rate snapshot, `refunded_at`, actor,
  reason, external settlement/reference id, and idempotency key;
- an explicit rule and constraint for full versus partial refunds and the sum
  of refunds permitted against one original payment;
- settlement state/timestamps if Void and Refund are to differ based on whether
  funds settled;
- immutable links such as `reversal_of_journal_entry_id` and source-event keys
  on the future journal tables;
- an approved accounting-date/closed-period adjustment mechanism;
- explicit tax-credit-note or tax-reversal evidence when required by the
  jurisdiction; and
- allocation records connecting a partial order refund to specific order
  items, discounts, taxes, inventory movements, and COGS layers.

Any new refund table carrying `tenant_id` must use forced RLS, composite
tenant-safe relationships, and tenant-context access. Monetary calculations
must not use floating-point numbers.

### Status

**مؤجل.** Neither the Void/Refund posting method nor the accounting-date policy
has been approved.

### What future implementation must not assume

- It must not assume that `payments.status = 'refunded'` identifies a refund
  amount smaller than or different from the immutable original payment; no
  independent `refunded_amount` exists today.
- It must not use `audit_log` as a substitute for a monetary refund subledger
  without an approved schema and invariants.
- It must not assume Void and Refund have identical accounting effects.
- It must not overwrite or delete the original payment or original journal
  entry; corrections must retain an immutable lineage.
- It must not silently choose the original transaction date or the later
  reversal date as the accounting date.
- It must not infer a tender reversal automatically implies revenue, tax,
  inventory, or COGS reversal.

## DD-005 — Inventory valuation and COGS

### Context

`stock_movements` is currently an append-only quantity ledger. Its financial
relevant links are `tenant_id`, `branch_id`, `inventory_item_id`,
`movement_type`, `quantity_delta`, optional `order_id` and `order_item_id`,
`actor_user_id`, optional `manager_override_id`, and its event timestamps.
Movement types distinguish sale deduction, void restoration, waste evidence,
manual receiving, and manual adjustment.

The table contains no unit-cost, extended-cost, cost-currency,
purchase-invoice-line, supplier, valuation-layer, or valuation-method column.
`inventory_items.current_quantity` is derived from the movement quantities.
Consequently, the current data can establish how much stock moved, but **COGS
cannot be inferred from the current data alone** and no financially reliable
inventory value can be reconstructed from `stock_movements`.

### Options

1. **FIFO.** Each receiving event creates one or more immutable cost layers;
   sale deductions consume the oldest available layers, and void restoration
   must define whether it restores the original consumed layers. This provides
   traceable historical cost but requires layer-level concurrency, allocation,
   and negative-stock rules.
2. **Weighted average.** Each valued receipt recalculates an average unit cost,
   and each sale deduction snapshots the then-current average. This reduces
   layer volume but requires precise rules for backdated receipts, negative
   stock, corrections, rounding residuals, and void restoration.
3. **Standard cost.** A versioned approved standard cost determines COGS, with
   purchase-price and inventory variances recorded separately. This gives
   predictable COGS but requires governance for standard-cost versions and
   additional variance accounts and events.

The valuation method could be tenant-wide, branch-specific, or item-specific,
but scope, defaults, transitions, and whether historical stock may change
method all require explicit approval. Each option must also decide the
accounting effects of `manual_receiving`, `manual_adjustment`, `waste_void`,
`waste_refund`, `void_restoration`, negative inventory approved by override,
and receipts recorded before a supplier invoice arrives.

### Additional data required for future implementation

Depending on the selected method, implementation may require:

- immutable receipt/purchase records with supplier, invoice/reference,
  inventory item, received quantity, unit cost, extended cost, currency,
  exchange-rate snapshot, branch, and occurrence/accounting dates;
- a versioned valuation-policy table specifying the approved method and its
  tenant/branch/item scope;
- FIFO `inventory_cost_layers` plus immutable layer-consumption allocations;
- weighted-average state and a per-movement snapshot of unit and extended cost;
- versioned standard costs and separate purchase-price/inventory-variance
  records;
- an immutable financial valuation movement linked one-to-one or one-to-many
  with `stock_movements.id`, recording cost in integer minor units and the
  relevant currency;
- reason and approval evidence for financially valued manual adjustments;
- explicit handling of negative stock and the later cost true-up when cost was
  unavailable at sale time; and
- links from sale, void, waste, and refund events to the original valuation
  consumption so reversals cannot use an unrelated current cost.

Valuation writes must serialize consistently with the existing inventory
quantity mutation and remain tenant-isolated. Application cost arithmetic must
use `BigInt` minor units through the existing money boundary; quantity decimal
arithmetic and money arithmetic must not be mixed implicitly.

### Status

**مؤجل.** No inventory valuation method, scope, transition rule, or COGS
recognition policy has been approved.

### What future implementation must not assume

- It must not derive COGS from `stock_movements.quantity_delta` alone; the table
  has no cost value.
- It must not treat menu sale price, current catalog price, or a later supplier
  price as historical inventory cost.
- It must not choose FIFO, weighted average, or standard cost merely because it
  is simpler to implement.
- It must not value a void, refund, waste event, or manual adjustment at current
  cost without an approved linkage and reversal policy.
- It must not silently assign zero cost when a sale drives inventory negative
  or when receipt cost is unavailable.
- It must not mutate historical quantity movements to add valuation after the
  fact; financial valuation evidence must be append-only and explicitly linked.
