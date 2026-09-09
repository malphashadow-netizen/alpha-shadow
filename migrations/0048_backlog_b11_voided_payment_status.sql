-- Migration 0048 — Backlog (B11): 'voided' order payment status.
--
-- A fully-voided order currently keeps payment_status = 'open' ("re-collection
-- required") — a lie that invites collecting money on a dead order (B9-b).
-- The status lifecycle gains a terminal 'voided' value, written ONLY by the
-- order-void path when zero active lines remain; every other transition stays
-- with the payment-lifecycle recompute (which preserves 'voided').
--
-- The 0027 order_voids audit CHECK is INTENTIONALLY unchanged: at void time
-- the live status is always 'open' (the void gate + the B9-a already-voided
-- guard reject everything else first), so the audit column never sees 'voided'.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT (0009/0029/0031
-- precedent). Widening only — every existing row already satisfies the new
-- CHECK. No new table → no RLS/grant change.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('open', 'paid', 'refund_pending', 'refunded', 'voided'));
