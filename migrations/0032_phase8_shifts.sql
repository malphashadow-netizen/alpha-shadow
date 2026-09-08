-- Migration 0032 — Phase 8 (4/7): shift reconciliations + cash counts.
--
-- shift_reconciliations is THE single, approved shift ledger:
--   * A row is created ONLY after the open cash count AND the dual
--     verification are BOTH complete — one atomic transaction inserts the row
--     (directly with status='open') together with its 'open' cash_count_details
--     rows. It can never be born 'closed' and never born without its count.
--   * Dual verification at open: open_verified_by_id MUST differ from
--     opened_by_id (CHECK). At close: close_verified_by_id MUST differ from
--     closed_by_id (CHECK) — one person can never hold both roles.
--   * The Z Report (the official close, the ONLY writer of the close columns)
--     turns the row 'closed' with counted_cash = SUM(close cash_count_details),
--     recorded_cash_sales = SUM of completed cash payments on the shift
--     (verified structurally once payments exists — migration 0034), and
--     variance = counted_cash - starting_float - recorded_cash_sales (a
--     GENERATED column: the formula cannot be written wrong).
--   * After close the row is IMMUTABLE (trigger rejects any UPDATE; DELETE is
--     always rejected — the row is financial evidence).
--   * The X Report is read-only by contract: it writes nothing, resets
--     nothing (enforced in the application engine, which only SELECTs).
--   * starting_float = SUM(open cash_count_details) — verified at commit by a
--     DEFERRED constraint trigger on cash_count_details.
--   * One open shift per cashier (partial unique index): overlapping parallel
--     shifts for the same cashier are structurally impossible.
--
-- cash_count_details is the append-only denomination-level count evidence:
--   * subtotal is GENERATED as denomination_value × quantity (never wrong).
--   * Counts are only writable while the referenced shift is 'open' (the
--     close count is written in the same transaction as, and just before, the
--     Z-Report UPDATE).
--   * UPDATE/DELETE are rejected: a count is permanent evidence; a mistake
--     surfaces in the variance, it is never rewritten.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

-- (a) shift_reconciliations.
CREATE TABLE IF NOT EXISTS shift_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  cashier_id uuid NOT NULL,
  opened_by_id uuid NOT NULL,
  open_verified_by_id uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  starting_float numeric(18,2) NOT NULL CHECK (starting_float >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by_id uuid,
  close_verified_by_id uuid,
  closed_at timestamptz,
  counted_cash numeric(18,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  recorded_cash_sales numeric(18,2),
  variance numeric(18,2) GENERATED ALWAYS AS (counted_cash - starting_float - recorded_cash_sales) STORED,
  variance_type text CHECK (variance_type IN ('overage', 'shortage', 'exact')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_reconciliations_id_tenant_key UNIQUE (id, tenant_id),
  -- Dual verification: one person can never hold both roles, at open AND at close.
  CONSTRAINT shift_open_dual_verification CHECK (open_verified_by_id <> opened_by_id),
  CONSTRAINT shift_close_dual_verification
    CHECK (close_verified_by_id IS NULL OR closed_by_id IS NULL OR close_verified_by_id <> closed_by_id),
  -- The close columns are all-or-nothing, exactly aligned with status:
  -- an open shift carries no close evidence; a closed shift carries ALL of it.
  CONSTRAINT shift_status_shape CHECK (
    (status = 'open'
       AND closed_by_id IS NULL AND close_verified_by_id IS NULL AND closed_at IS NULL
       AND counted_cash IS NULL AND recorded_cash_sales IS NULL AND variance_type IS NULL)
    OR (status = 'closed'
       AND closed_by_id IS NOT NULL AND close_verified_by_id IS NOT NULL AND closed_at IS NOT NULL
       AND counted_cash IS NOT NULL AND recorded_cash_sales IS NOT NULL AND variance_type IS NOT NULL)),
  -- variance_type always tells the truth about the generated variance column.
  CONSTRAINT shift_variance_type_matches CHECK (
    variance_type IS NULL
    OR variance_type = (CASE WHEN variance > 0 THEN 'overage'::text
                             WHEN variance < 0 THEN 'shortage'::text
                             ELSE 'exact'::text END)),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (cashier_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (opened_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (open_verified_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (closed_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (close_verified_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_shift_reconciliations_tenant_id ON shift_reconciliations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_shift_reconciliations_branch_status
  ON shift_reconciliations (tenant_id, branch_id, status);

-- One OPEN shift per cashier at a time: parallel overlapping shifts for the
-- same cashier are structurally impossible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shift_one_open_per_cashier
  ON shift_reconciliations (tenant_id, cashier_id) WHERE status = 'open';

ALTER TABLE shift_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_reconciliations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shift_reconciliations;
CREATE POLICY tenant_isolation ON shift_reconciliations
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Structural write guard:
--   * INSERT: a shift is born 'open' only (the open count + dual verification
--     already happened — atomically, in this same transaction).
--   * UPDATE: a closed row is immutable; the open-time identity columns
--     (branch, cashier, openers, opened_at, starting_float) never change;
--     status may only move 'open' → 'closed'; every recorded user must be an
--     active member of the tenant.
--   * DELETE: always forbidden — financial evidence is permanent.
CREATE FUNCTION validate_shift_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_active boolean;
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
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_shift_reconciliation ON shift_reconciliations;
CREATE TRIGGER trg_validate_shift_reconciliation BEFORE INSERT OR UPDATE OR DELETE ON shift_reconciliations
  FOR EACH ROW EXECUTE FUNCTION validate_shift_reconciliation();

-- (b) cash_count_details — append-only denomination-level count evidence.
CREATE TABLE IF NOT EXISTS cash_count_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  shift_reconciliation_id uuid NOT NULL,
  count_type text NOT NULL CHECK (count_type IN ('open', 'close')),
  denomination_value numeric(18,2) NOT NULL CHECK (denomination_value > 0),
  quantity integer NOT NULL CHECK (quantity >= 0),
  subtotal numeric(18,2) GENERATED ALWAYS AS (denomination_value * quantity) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_reconciliation_id, tenant_id)
    REFERENCES shift_reconciliations (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_cash_count_details_tenant_id ON cash_count_details (tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_count_details_shift
  ON cash_count_details (tenant_id, shift_reconciliation_id, count_type);

ALTER TABLE cash_count_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_count_details FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cash_count_details;
CREATE POLICY tenant_isolation ON cash_count_details
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Counts are permanent evidence: never rewritten, never deleted.
CREATE FUNCTION prevent_cash_count_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only count evidence: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS trg_cash_count_details_immutable ON cash_count_details;
CREATE TRIGGER trg_cash_count_details_immutable BEFORE UPDATE OR DELETE ON cash_count_details
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_count_mutation();

-- Counts are only writable while the referenced shift is OPEN (the close count
-- is written immediately before the Z-Report UPDATE, inside the same
-- transaction — never after the close).
CREATE FUNCTION validate_cash_count_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.shift_reconciliations
    WHERE id = NEW.shift_reconciliation_id AND tenant_id = NEW.tenant_id;
  IF v_status IS NULL OR v_status <> 'open' THEN
    RAISE EXCEPTION 'cash counts are only writable while the shift is open (never after the Z-Report close)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_cash_count_detail ON cash_count_details;
CREATE TRIGGER trg_validate_cash_count_detail BEFORE INSERT ON cash_count_details
  FOR EACH ROW EXECUTE FUNCTION validate_cash_count_detail();

-- DEFERRED consistency: at commit time the parent's stored sums must equal
-- the detail rows — starting_float = SUM(open counts); for a closed shift,
-- counted_cash = SUM(close counts). Runs after the whole atomic transaction
-- (shift row + details + optional close) is staged, so insert order inside
-- the transaction never matters.
CREATE FUNCTION verify_cash_count_sums() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_float numeric; v_counted numeric; v_sum_open numeric; v_sum_close numeric; v_status text;
BEGIN
  SELECT starting_float, counted_cash, status INTO v_float, v_counted, v_status
    FROM public.shift_reconciliations WHERE id = NEW.shift_reconciliation_id AND tenant_id = NEW.tenant_id;
  SELECT COALESCE(SUM(subtotal) FILTER (WHERE count_type = 'open'), 0),
         COALESCE(SUM(subtotal) FILTER (WHERE count_type = 'close'), 0)
    INTO v_sum_open, v_sum_close
    FROM public.cash_count_details WHERE shift_reconciliation_id = NEW.shift_reconciliation_id AND tenant_id = NEW.tenant_id;
  IF NEW.count_type = 'open' AND v_float <> v_sum_open THEN
    RAISE EXCEPTION 'starting_float must equal the sum of the open cash count details (% <> %)', v_float, v_sum_open USING ERRCODE = '23514';
  END IF;
  IF NEW.count_type = 'close' AND v_status = 'closed' AND v_counted <> v_sum_close THEN
    RAISE EXCEPTION 'counted_cash must equal the sum of the close cash count details (% <> %)', v_counted, v_sum_close USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_verify_cash_count_sums ON cash_count_details;
CREATE CONSTRAINT TRIGGER trg_verify_cash_count_sums AFTER INSERT ON cash_count_details
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_cash_count_sums();

REVOKE ALL ON shift_reconciliations, cash_count_details FROM PUBLIC;
