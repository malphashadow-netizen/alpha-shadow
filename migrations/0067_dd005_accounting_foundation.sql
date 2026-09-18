-- Migration 0067 — DD-005 accounting foundation.
-- Additive and idempotent: establishes the account purposes and provenance
-- needed by later inventory valuation work without assigning any costs.

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_tenant_system_purpose_unique
  ON accounts (tenant_id, system_purpose) WHERE system_purpose IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'branches_base_currency_fkey'
      AND conrelid = 'public.branches'::regclass
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_base_currency_fkey
      FOREIGN KEY (base_currency) REFERENCES currencies (code);
  END IF;
END;
$$;

ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS rate_source text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'exchange_rates_rate_source_check'
      AND conrelid = 'public.exchange_rates'::regclass
  ) THEN
    ALTER TABLE exchange_rates
      ADD CONSTRAINT exchange_rates_rate_source_check
      CHECK (rate_source IS NULL OR rate_source IN ('market', 'till_manual'));
  END IF;
END;
$$;
COMMENT ON COLUMN exchange_rates.rate_source IS
  'NULL = unclassified (pre-DD-005 rows). Reports MUST filter rate_source = ''market'' explicitly — fail-closed; never treat NULL as market.';
CREATE INDEX IF NOT EXISTS idx_exchange_rates_tenant_pair_source_effective
  ON exchange_rates (
    tenant_id,
    from_currency,
    to_currency,
    rate_source,
    effective_at DESC
  );

CREATE OR REPLACE FUNCTION log_payment_method_rate_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_to text;
BEGIN
  IF NEW.fixed_exchange_rate IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.fixed_exchange_rate IS DISTINCT FROM OLD.fixed_exchange_rate) THEN
    SELECT t.reporting_currency INTO v_to FROM public.tenants t WHERE t.id = NEW.tenant_id;
    IF v_to IS NOT NULL AND NEW.currency_code IS NOT NULL THEN
      INSERT INTO exchange_rates
        (tenant_id, from_currency, to_currency, rate, effective_at, rate_source)
      VALUES
        (NEW.tenant_id, NEW.currency_code, v_to, NEW.fixed_exchange_rate, now(), 'till_manual');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION seed_tenant_dd005_accounts(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_purpose text;
  v_count bigint;
  v_prev text;
BEGIN
  v_prev := current_setting('app.current_tenant_id', true);
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    PERFORM set_config('app.current_tenant_id', coalesce(v_prev, ''), true);
    RAISE EXCEPTION 'cannot seed DD-005 accounts for a non-existent tenant' USING ERRCODE = '23503';
  END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
  INSERT INTO public.accounts
    (tenant_id, code, name, account_type, normal_balance, system_purpose)
  VALUES
    (p_tenant_id, '1200', 'Inventory asset', 'asset', 'debit', 'inventory_asset'),
    (p_tenant_id, '1300', 'Cost of goods in process', 'asset', 'debit', 'cost_of_goods_in_process'),
    (p_tenant_id, '5000', 'Cost of goods sold', 'expense', 'debit', 'cost_of_goods_sold'),
    (p_tenant_id, '5100', 'Waste expense', 'expense', 'debit', 'waste_expense'),
    (p_tenant_id, '5200', 'Purchase price variance', 'expense', 'debit', 'purchase_price_variance'),
    (p_tenant_id, '5300', 'Inventory variance', 'expense', 'debit', 'inventory_variance')
  ON CONFLICT (tenant_id, code) DO NOTHING;

  FOREACH v_purpose IN ARRAY ARRAY[
    'inventory_asset',
    'cost_of_goods_in_process',
    'cost_of_goods_sold',
    'waste_expense',
    'purchase_price_variance',
    'inventory_variance'
  ] LOOP
    SELECT count(*) INTO v_count
    FROM public.accounts
    WHERE tenant_id = p_tenant_id AND system_purpose = v_purpose;
    IF v_count <> 1 THEN
      PERFORM set_config('app.current_tenant_id', coalesce(v_prev, ''), true);
      RAISE EXCEPTION 'DD-005 account purpose % has % rows for tenant %',
        v_purpose, v_count, p_tenant_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', coalesce(v_prev, ''), true);
END;
$$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS
  is_system_accounting_user boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_system_accounting_unique
  ON users (tenant_id) WHERE is_system_accounting_user;

CREATE OR REPLACE FUNCTION seed_tenant_dd005_system_user(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_count bigint;
  v_prev text;
BEGIN
  v_prev := current_setting('app.current_tenant_id', true);
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    PERFORM set_config('app.current_tenant_id', coalesce(v_prev, ''), true);
    RAISE EXCEPTION 'cannot seed DD-005 system user for a non-existent tenant' USING ERRCODE = '23503';
  END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
  INSERT INTO public.users
    (tenant_id, email, password_hash, is_active, is_system_accounting_user)
  VALUES
    (
      p_tenant_id,
      'dd005-system-accounting@system.invalid',
      'dd005-system-accounting-disabled',
      false,
      true
    )
  ON CONFLICT (tenant_id) WHERE is_system_accounting_user DO NOTHING;

  SELECT count(*) INTO v_count
  FROM public.users
  WHERE tenant_id = p_tenant_id AND is_system_accounting_user;
  IF v_count <> 1 THEN
    PERFORM set_config('app.current_tenant_id', coalesce(v_prev, ''), true);
    RAISE EXCEPTION 'DD-005 system accounting user has % rows for tenant %',
      v_count, p_tenant_id;
  END IF;
  PERFORM set_config('app.current_tenant_id', coalesce(v_prev, ''), true);
END;
$$;

SELECT seed_tenant_dd005_accounts(id) FROM tenants;
SELECT seed_tenant_dd005_system_user(id) FROM tenants;

CREATE OR REPLACE FUNCTION seed_new_tenant_payment_accounts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.seed_tenant_payment_accounts(NEW.id);
  PERFORM public.seed_tenant_dd005_accounts(NEW.id);
  PERFORM public.seed_tenant_dd005_system_user(NEW.id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION seed_tenant_dd005_accounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION seed_tenant_dd005_system_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION log_payment_method_rate_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION seed_new_tenant_payment_accounts() FROM PUBLIC;
