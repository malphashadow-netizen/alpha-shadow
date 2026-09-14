-- Defense in depth: PaymentsEngine.recordPayment() already rejects collections
-- on voided orders in the normal application path; enforce the same invariant
-- at the database boundary for direct or future payment insertion paths.

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
  IF v_order.payment_status IN ('refunded', 'refund_pending', 'voided') THEN
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
