-- Migration 0006 — Phase 4 multi-currency conversion and business audit log.
--
-- The `currencies` registry is global. `exchange_rates` and `audit_log` are
-- tenant-scoped and use the same mandatory RLS template as every other
-- tenant-scoped application table. `auth_audit_log` from Phase 3 is deliberately
-- not changed: it remains the separate global login-attempt ledger.
--
-- Amounts are not stored here in a reporting currency. A transaction keeps the
-- branch currency that was in force when it happened; the reporting layer
-- resolves a historical rate with effective_at <= transaction_time.
--
-- Production migrations are schema-only: no currency or rate rows are seeded.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- (a) currencies — global ISO 4217 reference registry.
CREATE TABLE IF NOT EXISTS currencies (
  code text PRIMARY KEY,
  minor_unit_digits smallint NOT NULL,
  CONSTRAINT currencies_code_iso_shape CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT currencies_minor_unit_digits_valid CHECK (minor_unit_digits BETWEEN 0 AND 4)
);

-- (b) exchange_rates — append-only, tenant-scoped historical rate ledger.
--     NUMERIC(18,8) is intentional: never change this to real/double precision
--     or pass it through a JavaScript number.
CREATE TABLE IF NOT EXISTS exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  from_currency text NOT NULL REFERENCES currencies (code),
  to_currency text NOT NULL REFERENCES currencies (code),
  rate numeric(18,8) NOT NULL CHECK (rate > 0),
  effective_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_tenant_pair_effective
  ON exchange_rates (tenant_id, from_currency, to_currency, effective_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_tenant_id ON exchange_rates (tenant_id);

ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON exchange_rates;
CREATE POLICY tenant_isolation ON exchange_rates
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- A rate is historical evidence. Even an owner/app role with an accidental
-- UPDATE/DELETE grant must not be able to rewrite that evidence in-place.
CREATE OR REPLACE FUNCTION prevent_exchange_rate_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'exchange_rates is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55006';
END;
$$;

DROP TRIGGER IF EXISTS exchange_rates_append_only ON exchange_rates;
CREATE TRIGGER exchange_rates_append_only
  BEFORE UPDATE OR DELETE ON exchange_rates
  FOR EACH ROW
  EXECUTE FUNCTION prevent_exchange_rate_mutation();

-- (c) audit_log — commercial/business audit trail. This is intentionally a
--     different table from Phase 3 auth_audit_log (login attempts only).
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid,
  action text NOT NULL,
  resource text NOT NULL,
  before jsonb,
  after jsonb,
  timestamp timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_timestamp
  ON audit_log (tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON audit_log (tenant_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Business audit rows are immutable evidence. The app_login grants are also
-- explicitly restricted in migrations/roles/004_app_login_phase4.sql; the
-- trigger protects the table even if a future DBA accidentally grants UPDATE
-- or DELETE.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable: % is forbidden', TG_OP
    USING ERRCODE = '55006';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

-- Defence in depth: no default table mutation privileges are inherited by a
-- role created later. The dedicated role script grants only SELECT/INSERT to
-- app_login after the role is provisioned.
REVOKE UPDATE, DELETE ON exchange_rates FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
