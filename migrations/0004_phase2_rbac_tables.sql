-- Migration 0004 — Phase 2 dynamic RBAC/ABAC engine: permissions registry + roles tables.
--
-- Style notes (same conventions as 0001/0003, enforced by tools/check-migrations.ts
-- and test/contract/rls-coverage.test.ts):
--   * Idempotent: CREATE … IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--     DROP POLICY IF EXISTS (re-creatable).
--   * NO `DROP TABLE` and NO `DROP … CASCADE` in this file: these are REAL tables.
--   * Every table with a tenant_id column carries the mandatory RLS template
--     (ENABLE + FORCE + one tenant_isolation FOR ALL policy whose USING and
--     WITH CHECK are both
--     `tenant_id = current_setting('app.current_tenant_id')::uuid`).
--   * NO data rows here: test/probe data lives in test/support/seed.test.sql and
--     the Vitest harness only (see migrations/README.md). The system role
--     TENANT_SUPER_ADMIN is seeded by the tenant-creation path (application
--     code), never by a static migration — see docs/backlog.md.

-- Ensure pgcrypto is available for gen_random_uuid() (idempotent).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- (a) permissions_registry — GLOBAL registry (deliberate exception: NO tenant_id,
--     NO RLS), exactly like `tenants`. key uses the "resource:action" shape.
CREATE TABLE IF NOT EXISTS permissions_registry (
  key text PRIMARY KEY,
  category text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false
);

-- (b) roles — tenant-scoped, full RLS.
CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  role_version integer NOT NULL DEFAULT 1,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Performance: tenant_id is the RLS/query hot path — always indexed.
CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON roles (tenant_id);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON roles;
CREATE POLICY tenant_isolation ON roles
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- (c) role_permissions — tenant-scoped, full RLS.
--     tenant_id is duplicated from roles.tenant_id on purpose so RLS never has
--     to join. max_amount_minor_units NULL = no financial cap for this grant.
CREATE TABLE IF NOT EXISTS role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  role_id uuid NOT NULL REFERENCES roles (id),
  permission_key text NOT NULL REFERENCES permissions_registry (key),
  max_amount_minor_units bigint,
  UNIQUE (role_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_tenant_id ON role_permissions (tenant_id);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON role_permissions;
CREATE POLICY tenant_isolation ON role_permissions
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- (d) user_roles — tenant-scoped, full RLS.
--     scope_type='tenant' ⇒ scope_id NULL; scope_type='branch' ⇒ scope_id
--     mandatory (enforced at the application layer, mirroring the column note).
CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role_id uuid NOT NULL REFERENCES roles (id),
  scope_type text NOT NULL CHECK (scope_type IN ('tenant', 'branch')),
  scope_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_roles_tenant_id ON user_roles (tenant_id);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON user_roles;
CREATE POLICY tenant_isolation ON user_roles
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
