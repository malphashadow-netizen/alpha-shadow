-- Migration 0001 — Phase 1 tenant isolation probe
-- Creates a probe table with RLS to verify withTenantContext wiring.
-- Every table with tenant_id must have RLS ENABLE + FORCE and a FOR ALL policy
-- whose USING and WITH CHECK both equal tenant_id = current_setting('app.current_tenant_id')::uuid

-- Ensure pgcrypto is available for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Drop clean if re-running in tests (idempotent)
DROP TABLE IF EXISTS tenant_probe CASCADE;

CREATE TABLE tenant_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payload text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_probe FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_probe;
CREATE POLICY tenant_isolation ON tenant_probe
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Additional helper: a second table to verify multiple tenant_id tables are covered
DROP TABLE IF EXISTS branch_probe CASCADE;

CREATE TABLE branch_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL
);

ALTER TABLE branch_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_probe FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON branch_probe;
CREATE POLICY tenant_isolation ON branch_probe
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
