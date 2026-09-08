-- Migration 0031 — Phase 8 (3/7): payment/discount permissions.
--
-- (a) permissions_registry extension: the order:discount:apply permission
--     CARRIES two cap columns, max_discount_percentage NUMERIC(5,2) and
--     max_discount_fixed_amount NUMERIC(18,2) — both nullable and
--     INDEPENDENT. The registry row declares the permission's cap dimensions;
--     the effective per-user values are set DYNAMICICALLY, per user, from the
--     permissions-management screen and live in user_discount_limits (c).
--     NULL for a dimension means "this dimension is NOT granted" (fail
--     closed) — never "unlimited": NULL + NULL = no discount authority at
--     all, exactly as the Phase-8 spec mandates.
--
-- (b) New atomic keys (resource:action, is_sensitive = true for every
--     money-affecting action — the payments engine placeholder's documented
--     discipline): order:discount:apply, payments:refund (mandated sensitive
--     by the spec), payments:void (the Void Payment leg of the
--     Void Payment → Reopen → Void Item → re-collection sequence).
--
-- (c) user_discount_limits — tenant-scoped, one row per user: the dynamic
--     per-user discount caps. A row with both caps NULL is an explicit
--     revocation (no discount authority whatsoever).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template
-- for the tenant-scoped table.

-- Tenant-safe composite FK target for users (id is already unique alone; the
-- same ALTER pattern as branches_id_tenant_key, migration 0012, kept
-- idempotent via DROP IF EXISTS + ADD). Needed by user_discount_limits here
-- and by shift_reconciliations / payments / order_discounts later.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_id_tenant_key;
ALTER TABLE users ADD CONSTRAINT users_id_tenant_key UNIQUE (id, tenant_id);

-- (a) The registry gains the two cap dimensions (nullable, independent).
ALTER TABLE permissions_registry ADD COLUMN IF NOT EXISTS max_discount_percentage numeric(5,2);
ALTER TABLE permissions_registry ADD COLUMN IF NOT EXISTS max_discount_fixed_amount numeric(18,2);

ALTER TABLE permissions_registry DROP CONSTRAINT IF EXISTS permissions_registry_discount_percentage_bounds;
ALTER TABLE permissions_registry ADD CONSTRAINT permissions_registry_discount_percentage_bounds
  CHECK (max_discount_percentage IS NULL OR (max_discount_percentage > 0 AND max_discount_percentage <= 100));
ALTER TABLE permissions_registry DROP CONSTRAINT IF EXISTS permissions_registry_discount_fixed_bounds;
ALTER TABLE permissions_registry ADD CONSTRAINT permissions_registry_discount_fixed_bounds
  CHECK (max_discount_fixed_amount IS NULL OR max_discount_fixed_amount > 0);

-- (b) Phase-8 atomic permission keys. Money-affecting ⇒ is_sensitive = true
--     (never cached by the L1 permission cache, re-read on every check).
INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('order:discount:apply', 'order', true),
  ('payments:refund', 'payments', true),
  ('payments:void', 'payments', true)
ON CONFLICT (key) DO NOTHING;

-- (c) Per-user dynamic discount caps (the permissions-management screen writes
--     these rows; the discount engine reads them live — sensitive permission,
--     never cached).
CREATE TABLE IF NOT EXISTS user_discount_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL,
  -- Single permission scoped for now; the shape stays extensible.
  permission_key text NOT NULL DEFAULT 'order:discount:apply' REFERENCES permissions_registry (key),
  max_discount_percentage numeric(5,2),
  max_discount_fixed_amount numeric(18,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_discount_limits_tenant_user_key UNIQUE (tenant_id, user_id),
  CONSTRAINT user_discount_limits_percentage_bounds
    CHECK (max_discount_percentage IS NULL OR (max_discount_percentage > 0 AND max_discount_percentage <= 100)),
  CONSTRAINT user_discount_limits_fixed_bounds
    CHECK (max_discount_fixed_amount IS NULL OR max_discount_fixed_amount > 0),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_user_discount_limits_tenant_id ON user_discount_limits (tenant_id);

ALTER TABLE user_discount_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_discount_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_discount_limits;
CREATE POLICY tenant_isolation ON user_discount_limits
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE ALL ON user_discount_limits FROM PUBLIC;
