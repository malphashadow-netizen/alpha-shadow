-- Migration 0003 — Phase 1 core tables: branches + users (tenant-scoped, RLS)
-- and the tenants.reporting_currency registry column.
--
-- Style notes (same conventions as 0001/0002, enforced by
-- tools/check-migrations.ts and test/contract/rls-coverage.test.ts):
--   * Idempotent: CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--     CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS (re-creatable).
--   * NO `DROP TABLE` and NO `DROP … CASCADE` in this file: branches/users are
--     REAL tables that carry data in production. 0001's tenant_probe /
--     branch_probe were the only tables designed to be dropped on re-run.
--   * Every table with a tenant_id column carries the mandatory RLS template
--     (ENABLE + FORCE + one tenant_isolation FOR ALL policy whose USING and
--     WITH CHECK are both `tenant_id = current_setting('app.current_tenant_id')::uuid`).
--   * NO data rows here: test/probe data lives in test/support/seed.test.sql
--     and is applied ONLY by the Vitest harness (see migrations/README.md).

-- Ensure pgcrypto is available for gen_random_uuid() (already created by 0001;
-- kept idempotent so this file is self-sufficient in any environment).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- (a) tenants.reporting_currency — the tenant's reporting/home currency.
--     Default 'SAR' matches the KSA-first deployment posture; every future
--     tenant INSERT should pass an explicit value. Kept NOT NULL DEFAULT so the
--     ALTER is safe on already-populated tenants rows (migration 0002 /
--     test seed) — NOT NULL without a default would fail on existing rows.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reporting_currency text NOT NULL DEFAULT 'SAR';

-- (b) branches — physical branch/site of a tenant (RLS row source, tenant-scoped).
CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  base_currency text NOT NULL,
  timezone text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Performance: tenant_id is the RLS/query hot path — always indexed.
CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches (tenant_id);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON branches;
CREATE POLICY tenant_isolation ON branches
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- (c) users — tenant-scoped login identities (password and/or PIN auth in
--     later phases). branch_id references branches; the FK check runs under
--     the caller's RLS, so a tenant can never point a user at another
--     tenant's branch (invisible row → FK violation) — defence in depth.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid REFERENCES branches (id),
  email text NOT NULL,
  password_hash text,
  pin_hash text,
  is_active boolean NOT NULL DEFAULT true,
  security_version integer NOT NULL DEFAULT 1,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_password_or_pin_required
    CHECK (password_hash IS NOT NULL OR pin_hash IS NOT NULL)
);

-- Emails are unique per tenant (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email
  ON users (tenant_id, lower(email));

-- Performance: tenant_id is the RLS/query hot path — always indexed.
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users (tenant_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
