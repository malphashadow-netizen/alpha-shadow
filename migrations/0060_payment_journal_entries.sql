-- Migration 0060 — payment-completion journal posting (DD-003).
--
-- Adds the tenant chart-of-accounts seed and the immutable double-entry
-- evidence written atomically with a completed payment. Payment-method
-- clearing is data-driven: the one-time type mapping below backfills existing
-- rows only; normal operation reads clearing_account_system_purpose.
--
-- Style: additive/idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  account_type text NOT NULL CHECK (account_type IN (
    'asset', 'liability', 'equity', 'revenue', 'expense', 'contra_revenue')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  system_purpose text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT accounts_tenant_code_key UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_id ON accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_accounts_system_purpose
  ON accounts (tenant_id, system_purpose) WHERE system_purpose IS NOT NULL;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON accounts;
CREATE POLICY tenant_isolation ON accounts
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  entry_number bigint GENERATED ALWAYS AS IDENTITY,
  accounting_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES currencies (code),
  description text,
  posted_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT journal_entries_tenant_number_key UNIQUE (tenant_id, entry_number),
  CONSTRAINT journal_entries_source_key UNIQUE (tenant_id, source_type, source_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (posted_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_id ON journal_entries (tenant_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_accounting_date
  ON journal_entries (tenant_id, accounting_date, entry_number);

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_entries;
CREATE POLICY tenant_isolation ON journal_entries
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  journal_entry_id uuid NOT NULL,
  line_number smallint NOT NULL CHECK (line_number > 0),
  account_id uuid NOT NULL,
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entry_lines_side_check CHECK (
    (debit_minor > 0 AND credit_minor = 0)
    OR (credit_minor > 0 AND debit_minor = 0)),
  CONSTRAINT journal_entry_lines_entry_line_key UNIQUE
    (tenant_id, journal_entry_id, line_number),
  FOREIGN KEY (journal_entry_id, tenant_id)
    REFERENCES journal_entries (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES accounts (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_tenant_id ON journal_entry_lines (tenant_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_account
  ON journal_entry_lines (tenant_id, account_id, journal_entry_id);

ALTER TABLE journal_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_entry_lines;
CREATE POLICY tenant_isolation ON journal_entry_lines
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Three Phase-1 system accounts only. ON CONFLICT by code preserves any
-- explicitly provisioned tenant account rather than rewriting it.
CREATE FUNCTION seed_tenant_payment_accounts(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'cannot seed accounts for a non-existent tenant' USING ERRCODE = '23503';
  END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
  INSERT INTO public.accounts
    (tenant_id, code, name, account_type, normal_balance, system_purpose)
  VALUES
    (p_tenant_id, '1000', 'Cash on hand', 'asset', 'debit', 'cash_on_hand'),
    (p_tenant_id, '1100', 'Card clearing', 'asset', 'debit', 'card_clearing'),
    (p_tenant_id, '4000', 'Sales revenue', 'revenue', 'credit', 'sales_revenue')
  ON CONFLICT (tenant_id, code) DO NOTHING;
END;
$$;

SELECT seed_tenant_payment_accounts(id) FROM tenants;

CREATE FUNCTION seed_new_tenant_payment_accounts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.seed_tenant_payment_accounts(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_seed_tenant_payment_accounts ON tenants;
CREATE TRIGGER trg_seed_tenant_payment_accounts
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION seed_new_tenant_payment_accounts();

-- One-time historical classification only. New and updated methods carry an
-- ordinary data value supplied by administration.
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS clearing_account_system_purpose text;
UPDATE payment_methods
   SET clearing_account_system_purpose = CASE
     WHEN type IN ('cash', 'foreign_currency_cash') THEN 'cash_on_hand'
     ELSE 'card_clearing'
   END
 WHERE clearing_account_system_purpose IS NULL;
ALTER TABLE payment_methods
  ALTER COLUMN clearing_account_system_purpose SET NOT NULL;
-- Compatibility for legacy/direct INSERT statements that omit the new
-- column. Normal administration always supplies an explicit data value.
ALTER TABLE payment_methods
  ALTER COLUMN clearing_account_system_purpose SET DEFAULT 'card_clearing';

-- Posted accounting evidence is append-only. DD-004 corrections use separate
-- reversal entries and never mutate the original payment evidence.
CREATE FUNCTION prevent_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable accounting evidence: % is forbidden',
    TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_journal_mutation();
DROP TRIGGER IF EXISTS trg_journal_entry_lines_immutable ON journal_entry_lines;
CREATE TRIGGER trg_journal_entry_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_journal_mutation();

-- Every posted header must finish the transaction with at least two balanced
-- lines. Deferred evaluation permits the header to be inserted before lines.
CREATE FUNCTION require_balanced_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count bigint;
  v_debits numeric;
  v_credits numeric;
BEGIN
  SELECT count(*), COALESCE(sum(debit_minor), 0), COALESCE(sum(credit_minor), 0)
    INTO v_count, v_debits, v_credits
    FROM public.journal_entry_lines
   WHERE tenant_id = NEW.tenant_id AND journal_entry_id = NEW.id;
  IF v_count < 2 OR v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal entry must contain at least two balanced lines'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_journal_entry_balanced ON journal_entries;
CREATE CONSTRAINT TRIGGER trg_journal_entry_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_balanced_journal_entry();

REVOKE ALL ON accounts, journal_entries, journal_entry_lines FROM PUBLIC;
REVOKE ALL ON FUNCTION seed_tenant_payment_accounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION seed_new_tenant_payment_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_journal_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION require_balanced_journal_entry() FROM PUBLIC;
