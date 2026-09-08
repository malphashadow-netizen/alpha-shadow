-- Migration 0035 — Phase 8 (7/7): payments.
--
-- payments is the money-collection evidence ledger:
--   * Every payment is bound to an OPEN shift (shift_id NOT NULL + the
--     validation trigger) — the shift GATEWAY: no new payments for a cashier
--     without a standing status='open' shift, structurally. The same gateway
--     is enforced for NEW ORDERS by the order-creation engine (fail-closed).
--   * exchange_rate_snapshot is frozen forever once written (UPDATE rejected
--     with a dedicated error) — a payment never re-values itself.
--   * Foreign currency is cash-only (type='foreign_currency_cash'): the
--     snapshot copies the method's manual fixed rate at tender time, the
--     base-currency value is amount × rate − change, and change is ALWAYS
--     given in the branch base currency. Card/wallet/other: no rate, no
--     change, amount_in_base = amount.
--   * amount_in_base_currency is NET of change: it is the figure that counts
--     toward the order balance and toward recorded_cash_sales.
--   * Lifecycle: completed → voided (full void evidence triple) or completed
--     → refunded (audited in audit_log); both terminal. Amounts, links,
--     snapshot and creator are immutable; rows are never deleted. Any status
--     mutation additionally requires the shift to still be OPEN (a closed
--     shift's Z-Report numbers can never be rewritten by a later void).
--   * This migration also upgrades validate_shift_reconciliation (0032) so
--     the Z-Report close STRUCTURALLY verifies recorded_cash_sales = SUM of
--     completed cash payments (cash + foreign_currency_cash) on the shift.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  amount_in_base_currency numeric(18,2) NOT NULL CHECK (amount_in_base_currency > 0),
  exchange_rate_snapshot numeric(18,8) CHECK (exchange_rate_snapshot IS NULL OR exchange_rate_snapshot > 0),
  change_given_amount numeric(18,2) CHECK (change_given_amount IS NULL OR change_given_amount >= 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided', 'refunded')),
  shift_id uuid NOT NULL,
  created_by uuid NOT NULL,
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_id_tenant_key UNIQUE (id, tenant_id),
  -- Void evidence is an all-or-nothing triple.
  CONSTRAINT payments_void_evidence CHECK (
    (voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  -- A voided payment always carries its evidence; a refund carries none
  -- (refund evidence lives in audit_log — the spec's column list has no
  -- refunded_by/refunded_at columns).
  CONSTRAINT payments_voided_status_shape CHECK (status <> 'voided' OR voided_by IS NOT NULL),
  CONSTRAINT payments_refunded_status_shape CHECK (status <> 'refunded' OR voided_by IS NULL),
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_method_id, tenant_id) REFERENCES payment_methods (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (shift_id, tenant_id) REFERENCES shift_reconciliations (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (voided_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_id ON payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (tenant_id, order_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments (tenant_id, shift_id, status);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payments;
CREATE POLICY tenant_isolation ON payments
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Full structural validation at INSERT (fail-closed on every write path).
CREATE FUNCTION validate_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_order record;
  v_shift record;
  v_method record;
  v_net numeric;
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

  v_net := COALESCE(NEW.change_given_amount, 0);
  IF v_method.type = 'foreign_currency_cash' THEN
    -- Manual fixed-rate conversion, change ALWAYS in the branch base currency.
    -- The tolerance of half a minor unit absorbs the engine's banker's
    -- rounding of amount × rate into NUMERIC(18,2); any wrong rate or wrong
    -- arithmetic is orders of magnitude outside it.
    IF NEW.exchange_rate_snapshot IS DISTINCT FROM v_method.fixed_exchange_rate THEN
      RAISE EXCEPTION 'exchange_rate_snapshot must copy the method''s current fixed rate at tender time' USING ERRCODE = '23514';
    END IF;
    IF abs(NEW.amount * NEW.exchange_rate_snapshot - v_net - NEW.amount_in_base_currency) > 0.005 THEN
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
DROP TRIGGER IF EXISTS trg_validate_payment ON payments;
CREATE TRIGGER trg_validate_payment BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION validate_payment();

-- Evidence guard: only the lifecycle columns ever change; the FX snapshot and
-- every money/link column are frozen at creation; voids/refunds only from
-- 'completed'; any mutation requires the shift to still be open.
CREATE FUNCTION guard_payment_writes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_shift_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments is permanent financial evidence: DELETE is forbidden' USING ERRCODE = '55006';
  END IF;

  IF NEW.exchange_rate_snapshot IS DISTINCT FROM OLD.exchange_rate_snapshot THEN
    RAISE EXCEPTION 'payments.exchange_rate_snapshot is immutable after the payment is recorded' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.payment_method_id IS DISTINCT FROM OLD.payment_method_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.amount_in_base_currency IS DISTINCT FROM OLD.amount_in_base_currency
     OR NEW.change_given_amount IS DISTINCT FROM OLD.change_given_amount
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment money/link evidence is immutable; only the lifecycle columns may change' USING ERRCODE = '42501';
  END IF;

  IF NOT (OLD.status = 'completed' AND NEW.status IN ('completed', 'voided', 'refunded')) THEN
    RAISE EXCEPTION 'payment status may only move completed → voided or completed → refunded' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'voided' AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.voided_by AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'payment void requires an active voider of the same tenant' USING ERRCODE = '23514';
  END IF;

  SELECT status INTO v_shift_status FROM public.shift_reconciliations
    WHERE id = NEW.shift_id AND tenant_id = NEW.tenant_id;
  IF v_shift_status IS NULL OR v_shift_status <> 'open' THEN
    RAISE EXCEPTION 'payment lifecycle changes are only allowed while the shift is open (a closed shift''s Z-Report numbers are final)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_payment_writes ON payments;
CREATE TRIGGER trg_guard_payment_writes BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION guard_payment_writes();

-- Upgrade of validate_shift_reconciliation (created in 0032; trigger stays
-- attached): the Z-Report close now STRUCTURALLY verifies that
-- recorded_cash_sales equals the live SUM of completed cash payments
-- (cash + foreign_currency_cash, net base-currency value) on this shift.
-- variance = counted_cash − starting_float − recorded_cash_sales remains the
-- generated column from 0032.
CREATE OR REPLACE FUNCTION validate_shift_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
  v_recorded numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shift_reconciliations is permanent financial evidence: DELETE is forbidden' USING ERRCODE = '55006';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'a shift is created only as ''open'' (open count + dual verification complete, atomic)' USING ERRCODE = '23514';
    END IF;
    FOR v_active IN SELECT u.is_active FROM public.users u
      WHERE u.id IN (NEW.cashier_id, NEW.opened_by_id, NEW.open_verified_by_id)
        AND u.tenant_id = NEW.tenant_id
    LOOP
      IF NOT v_active THEN
        RAISE EXCEPTION 'shift participants (cashier/opener/verifier) must be active members of the same tenant' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM public.users u WHERE u.id IN (NEW.cashier_id, NEW.opened_by_id, NEW.open_verified_by_id)
          AND u.tenant_id = NEW.tenant_id AND u.is_active) <> 3 THEN
      RAISE EXCEPTION 'shift participants (cashier/opener/verifier) must be active members of the same tenant' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'shift_reconciliations is immutable after the Z-Report close: UPDATE is forbidden' USING ERRCODE = '55006';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.cashier_id IS DISTINCT FROM OLD.cashier_id
     OR NEW.opened_by_id IS DISTINCT FROM OLD.opened_by_id
     OR NEW.open_verified_by_id IS DISTINCT FROM OLD.open_verified_by_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.starting_float IS DISTINCT FROM OLD.starting_float THEN
    RAISE EXCEPTION 'shift open-time evidence (branch/cashier/openers/opened_at/starting_float) is immutable' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = 'open' AND (NEW.status = 'open' OR NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'shift status may only move ''open'' → ''closed'' (the Z Report)' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'closed' THEN
    IF (SELECT count(*) FROM public.users u WHERE u.id IN (NEW.cashier_id, NEW.closed_by_id, NEW.close_verified_by_id)
          AND u.tenant_id = NEW.tenant_id AND u.is_active) <> 3 THEN
      RAISE EXCEPTION 'shift close participants (closer/verifier) must be active members of the same tenant' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(p.amount_in_base_currency), 0) INTO v_recorded
      FROM public.payments p
      JOIN public.payment_methods m ON m.id = p.payment_method_id AND m.tenant_id = p.tenant_id
      WHERE p.shift_id = NEW.id AND p.tenant_id = NEW.tenant_id
        AND p.status = 'completed' AND m.type IN ('cash', 'foreign_currency_cash');
    IF NEW.recorded_cash_sales <> v_recorded THEN
      RAISE EXCEPTION 'recorded_cash_sales must equal the sum of completed cash payments on the shift (% <> %)',
        NEW.recorded_cash_sales, v_recorded USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON payments FROM PUBLIC;
