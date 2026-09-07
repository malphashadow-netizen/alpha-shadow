-- Migration 0026 — Phase 7 (9/10): tenant void reasons + kind settings + void settings.
--
-- tenant_void_reasons       — a tenant's own free-form reasons. Each carries a
--                             MANDATORY FK to a platform void_reason_kind (the
--                             classification can never be lost) and the minimum
--                             permission tier required to use it without a
--                             manager override (graded 3-level model:
--                             server / shift_supervisor / manager — read from
--                             permissions_registry, never a binary flag).
-- tenant_void_reason_kind_settings — per-tenant per-kind is_enabled switch:
--                             DISABLE INSTEAD OF DELETE (the void_reason_kinds
--                             analogue of tenant_order_workflow_states).
-- tenant_void_settings      — optional void time limit (NULL = no limit),
--                             enforced from order_items.created_at.
--
-- Permission keys seeded below follow the atomic `resource:action` registry
-- format and are is_sensitive = true (money-affecting action).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS tenant_void_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  void_reason_kind_code text NOT NULL REFERENCES void_reason_kinds (code) ON DELETE RESTRICT,
  label text NOT NULL CHECK (btrim(label) <> ''),
  required_permission_tier text NOT NULL DEFAULT 'server'
    CHECK (required_permission_tier IN ('server', 'shift_supervisor', 'manager')),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- order_voids (migration 0027) references these rows with ON DELETE
  -- RESTRICT: a reason used in history can never be deleted.
  CONSTRAINT tenant_void_reasons_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT tenant_void_reasons_tenant_label UNIQUE (tenant_id, label)
);
CREATE INDEX IF NOT EXISTS idx_tenant_void_reasons_tenant_id ON tenant_void_reasons (tenant_id);

ALTER TABLE tenant_void_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_void_reasons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_void_reasons;
CREATE POLICY tenant_isolation ON tenant_void_reasons
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Disable-instead-of-delete switch for the PLATFORM kind, per tenant.
CREATE TABLE IF NOT EXISTS tenant_void_reason_kind_settings (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  void_reason_kind_code text NOT NULL REFERENCES void_reason_kinds (code) ON DELETE RESTRICT,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, void_reason_kind_code)
);

ALTER TABLE tenant_void_reason_kind_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_void_reason_kind_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_void_reason_kind_settings;
CREATE POLICY tenant_isolation ON tenant_void_reason_kind_settings
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- One settings row per tenant; NULL limit = unlimited voids.
CREATE TABLE IF NOT EXISTS tenant_void_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  void_time_limit_minutes integer CHECK (void_time_limit_minutes IS NULL OR void_time_limit_minutes > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_void_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_void_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_void_settings;
CREATE POLICY tenant_isolation ON tenant_void_settings
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Graded void permissions (3 levels — the spec's server/shift_supervisor/
-- manager ladder), registered in the EXISTING permissions_registry.
INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('order:void', 'order', true),
  ('order:void:shift_supervisor', 'order', true),
  ('order:void:manager', 'order', true)
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON tenant_void_reasons, tenant_void_reason_kind_settings, tenant_void_settings FROM PUBLIC;
