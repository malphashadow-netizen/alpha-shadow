-- Migration 0044 — Phase 8b fix (B1): ISO-scale money storage.
--
-- Phase-8 money-major columns were NUMERIC(18,2) while every engine computes
-- in ISO minor units (KWD fils = 3 decimals, JPY = 0): formatting ISO-minor
-- at a hardcoded scale of 2 inflated every KWD row 10x (1005 fils stored as
-- "10.05") and shrank every JPY row 100x (104 yen stored as "1.04"). From
-- here on every money-major column is NUMERIC(18,4) — 4 is the largest ISO
-- 4217 minor scale of any active currency (CLF/UYW; everything else is 0-3)
-- — and engines format/parse at the row's own currency scale
-- (storageMinorUnitDigits, src/shared/decimal-text.ts), so KWD (3) and JPY
-- (0) round-trip exactly. Existing 2-decimal values are preserved verbatim by
-- the widening (a 2-decimal value is already a valid 4-decimal value).
--
-- validate_payment() is recreated with a currency-aware FX tolerance: half a
-- minor unit of the branch base currency (was hardcoded 0.005 = half a cent,
-- 10x too loose for KWD and 100x too tight-or-loose class error for JPY).
-- The engine's only residue is banker's rounding of amount x rate, strictly
-- below half a minor unit, so the new bound accepts every honest row and
-- rejects every >= 1-minor-unit error. The non-FX exact-equality path is
-- scale-agnostic and unchanged, as is the recorded_cash_sales exact SUM check
-- (0035) and the ISO-aware discount trigger (v_digits, 0034/0036).
--
-- currency_denominations widens with the rest, and the KWD sub-cent coins
-- (5/10/20 fils — real circulation coins the 0030 NOTE excluded as
-- unrepresentable) are seeded under the same global-reference-data exception
-- (ON CONFLICT DO NOTHING, never DO UPDATE). No RLS block: no new table
-- carries tenant_id (existing tables keep their policies).
--
-- Style notes: idempotent (ALTER TYPE to the same type is a no-op,
-- DROP COLUMN/CONSTRAINT IF EXISTS + re-add, CREATE OR REPLACE,
-- ON CONFLICT DO NOTHING), no DROP TABLE / CASCADE.

-- (a) Payments evidence: tendered, net base value, change.
ALTER TABLE payments ALTER COLUMN amount TYPE numeric(18,4);
ALTER TABLE payments ALTER COLUMN amount_in_base_currency TYPE numeric(18,4);
ALTER TABLE payments ALTER COLUMN change_given_amount TYPE numeric(18,4);

-- (b) Discount evidence + coupon minimums + per-user fixed caps.
ALTER TABLE order_discounts ALTER COLUMN discount_amount_applied TYPE numeric(18,4);
ALTER TABLE coupons ALTER COLUMN min_order_amount TYPE numeric(18,4);
ALTER TABLE user_discount_limits ALTER COLUMN max_discount_fixed_amount TYPE numeric(18,4);
ALTER TABLE permissions_registry ALTER COLUMN max_discount_fixed_amount TYPE numeric(18,4);

-- (c) Shift evidence: float, counted, recorded, counts.
-- variance and subtotal are GENERATED columns, and PostgreSQL forbids ALTER
-- TYPE on any column a generated column reads (0A000) — so the generated
-- columns are dropped and re-added at the widened type with byte-identical
-- expressions (their values are recomputed from the widened inputs; no
-- evidence is lost). The shift_variance_type_matches CHECK reads variance,
-- so it is dropped first and re-added verbatim after the rebuild. Every
-- INSERT names its columns and every reader maps by name, so the new ordinal
-- positions (variance/subtotal move to the end) change nothing.
ALTER TABLE shift_reconciliations DROP CONSTRAINT IF EXISTS shift_variance_type_matches;
ALTER TABLE shift_reconciliations DROP COLUMN IF EXISTS variance;
ALTER TABLE shift_reconciliations ALTER COLUMN starting_float TYPE numeric(18,4);
ALTER TABLE shift_reconciliations ALTER COLUMN counted_cash TYPE numeric(18,4);
ALTER TABLE shift_reconciliations ALTER COLUMN recorded_cash_sales TYPE numeric(18,4);
ALTER TABLE shift_reconciliations
  ADD COLUMN variance numeric(18,4)
  GENERATED ALWAYS AS (counted_cash - starting_float - recorded_cash_sales) STORED;
ALTER TABLE shift_reconciliations ADD CONSTRAINT shift_variance_type_matches CHECK (
  variance_type IS NULL
  OR variance_type = (CASE WHEN variance > 0 THEN 'overage'::text
                           WHEN variance < 0 THEN 'shortage'::text
                           ELSE 'exact'::text END));
ALTER TABLE cash_count_details DROP COLUMN IF EXISTS subtotal;
ALTER TABLE cash_count_details ALTER COLUMN denomination_value TYPE numeric(18,4);
ALTER TABLE cash_count_details
  ADD COLUMN subtotal numeric(18,4)
  GENERATED ALWAYS AS (denomination_value * quantity) STORED;

-- (d) The denomination registry widens with the columns it documents.
ALTER TABLE currency_denominations ALTER COLUMN value TYPE numeric(18,4);

-- (e) validate_payment() with a currency-aware FX tolerance. Trigger
-- trg_validate_payment stays attached (CREATE OR REPLACE keeps triggers).
CREATE OR REPLACE FUNCTION validate_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_order record;
  v_shift record;
  v_method record;
  v_net numeric;
  v_digits smallint;
BEGIN
  SELECT o.branch_id, o.payment_status INTO v_order
    FROM public.orders o WHERE o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id;
  IF v_order IS NULL THEN
    RAISE EXCEPTION 'payment must reference an order of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF v_order.payment_status IN ('refunded', 'refund_pending') THEN
    RAISE EXCEPTION 'a % order cannot take a new payment', v_order.payment_status USING ERRCODE = '23514';
  END IF;

  -- GATEWAY: the payment must land on an OPEN shift of the same branch, and
  -- its creator must BE that shift's cashier (a payment is always taken by
  -- the cashier whose drawer it enters).
  SELECT s.status, s.branch_id, s.cashier_id INTO v_shift
    FROM public.shift_reconciliations s
    WHERE s.id = NEW.shift_id AND s.tenant_id = NEW.tenant_id;
  IF v_shift IS NULL OR v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'payments are only allowed on a standing open shift (the shift gateway)' USING ERRCODE = '23514';
  END IF;
  IF v_shift.branch_id <> v_order.branch_id THEN
    RAISE EXCEPTION 'payment shift must be at the order''s branch' USING ERRCODE = '23514';
  END IF;
  IF v_shift.cashier_id <> NEW.created_by THEN
    RAISE EXCEPTION 'payment creator must be the shift cashier' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = NEW.created_by AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'payment creator must be an active member of the same tenant' USING ERRCODE = '23514';
  END IF;

  SELECT m.type, m.currency_code, m.fixed_exchange_rate, m.is_active, m.branch_id
    INTO v_method FROM public.payment_methods m
    WHERE m.id = NEW.payment_method_id AND m.tenant_id = NEW.tenant_id;
  IF v_method IS NULL OR NOT v_method.is_active THEN
    RAISE EXCEPTION 'payment requires an active payment method of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF v_method.branch_id IS NOT NULL AND v_method.branch_id <> v_order.branch_id THEN
    RAISE EXCEPTION 'payment method is not available at the order''s branch' USING ERRCODE = '23514';
  END IF;

  -- B1: the branch base currency scale drives the FX tolerance below.
  SELECT c.minor_unit_digits INTO v_digits
    FROM public.branches b JOIN public.currencies c ON c.code = b.base_currency
    WHERE b.id = v_order.branch_id AND b.tenant_id = NEW.tenant_id;
  IF v_digits IS NULL THEN
    RAISE EXCEPTION 'branch base currency is not in the currencies registry' USING ERRCODE = '23514';
  END IF;

  v_net := COALESCE(NEW.change_given_amount, 0);
  IF v_method.type = 'foreign_currency_cash' THEN
    -- Manual fixed-rate conversion, change ALWAYS in the branch base currency.
    -- The tolerance of half a minor unit of the branch base currency absorbs
    -- the engine's banker's rounding of amount x rate; any wrong rate or
    -- wrong arithmetic (>= 1 minor unit) is outside it. Strictly greater:
    -- an exact half-unit residue (round-to-even) still passes.
    IF NEW.exchange_rate_snapshot IS DISTINCT FROM v_method.fixed_exchange_rate THEN
      RAISE EXCEPTION 'exchange_rate_snapshot must copy the method''s current fixed rate at tender time' USING ERRCODE = '23514';
    END IF;
    IF abs(NEW.amount * NEW.exchange_rate_snapshot - v_net - NEW.amount_in_base_currency) > 0.5 * power(10, -v_digits) THEN
      RAISE EXCEPTION 'amount_in_base_currency must equal amount × exchange_rate_snapshot − change_given_amount' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- Card / wallet / other (and domestic cash): no rate, same-currency math.
    IF NEW.exchange_rate_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'exchange_rate_snapshot is only allowed for foreign_currency_cash methods' USING ERRCODE = '23514';
    END IF;
    IF NEW.amount_in_base_currency <> NEW.amount - v_net THEN
      RAISE EXCEPTION 'amount_in_base_currency must equal amount − change_given_amount (non-FX methods)' USING ERRCODE = '23514';
    END IF;
    IF v_method.type <> 'cash' AND NEW.change_given_amount IS NOT NULL THEN
      RAISE EXCEPTION 'change is only given on cash methods' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- (f) KWD sub-cent circulation coins (5/10/20 fils). The 50/100-fils coins and
-- the quarter/half-dinar notes were already seeded by 0030; this completes the
-- KWD series now that the registry can represent it.
INSERT INTO currency_denominations (currency_code, value, label) VALUES
  ('KWD', 0.005, '5 fils'), ('KWD', 0.010, '10 fils'), ('KWD', 0.020, '20 fils')
ON CONFLICT (currency_code, value) DO NOTHING;
