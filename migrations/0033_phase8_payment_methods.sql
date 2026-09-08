-- Migration 0033 — Phase 8 (5/7): payment methods.
--
-- payment_methods is tenant configuration data:
--   * type vocabulary is fixed by the spec: cash | card | wallet |
--     foreign_currency_cash | other.
--   * branch_id NULL = the method is available in EVERY branch of the tenant.
--   * Foreign currency is CASH ONLY: a foreign_currency_cash method must
--     carry a currency_code and a positive fixed_exchange_rate; every other
--     type must carry NEITHER (card/wallet/other always settle in the branch
--     base currency — enforced by the fx_shape CHECK).
--   * fixed_exchange_rate is a MANUAL, fixed rate (no live FX API — deferred
--     by the spec). EVERY change to it (including the initial provisioning)
--     is appended to the tenant's exchange_rates ledger by the trigger below,
--     so the rate history is permanent evidence; payments additionally freeze
--     the rate they actually used in payments.exchange_rate_snapshot.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- NULL = every branch of the tenant.
  branch_id uuid,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('cash', 'card', 'wallet', 'foreign_currency_cash', 'other')),
  currency_code text REFERENCES currencies (code),
  fixed_exchange_rate numeric(18,8),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_methods_id_tenant_key UNIQUE (id, tenant_id),
  -- Foreign currency is cash-only and ALWAYS fully configured; every other
  -- type carries neither a currency nor a rate.
  CONSTRAINT payment_methods_fx_shape CHECK (
    (type = 'foreign_currency_cash' AND currency_code IS NOT NULL
       AND fixed_exchange_rate IS NOT NULL AND fixed_exchange_rate > 0)
    OR (type <> 'foreign_currency_cash' AND currency_code IS NULL AND fixed_exchange_rate IS NULL)),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_payment_methods_tenant_id ON payment_methods (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_tenant_branch ON payment_methods (tenant_id, branch_id);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_methods;
CREATE POLICY tenant_isolation ON payment_methods
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Every provisioning/change of the manual fixed rate is appended to the
-- tenant's exchange_rates ledger (append-only by its own trigger, 0006).
-- The pair is recorded against the tenant's reporting currency — the ledger
-- row is the audit fact "the manual rate for this method changed to X",
-- while the per-payment snapshot records the rate actually used at tender
-- time. INSERT is logged too, so the initial rate is part of the history.
CREATE FUNCTION log_payment_method_rate_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_to text;
BEGIN
  IF NEW.fixed_exchange_rate IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.fixed_exchange_rate IS DISTINCT FROM OLD.fixed_exchange_rate) THEN
    SELECT t.reporting_currency INTO v_to FROM public.tenants t WHERE t.id = NEW.tenant_id;
    IF v_to IS NOT NULL AND NEW.currency_code IS NOT NULL THEN
      INSERT INTO exchange_rates (tenant_id, from_currency, to_currency, rate, effective_at)
      VALUES (NEW.tenant_id, NEW.currency_code, v_to, NEW.fixed_exchange_rate, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_payment_method_rate_ledger ON payment_methods;
CREATE TRIGGER trg_payment_method_rate_ledger AFTER INSERT OR UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION log_payment_method_rate_change();

REVOKE ALL ON payment_methods FROM PUBLIC;
