-- Migration 0049 — Backlog (I1): coded manual-adjustment reasons.
--
-- Manual stock adjustments "can hide shrinkage or theft" (inventory engine
-- header) yet carried no reason at all. They now carry a MANDATORY coded
-- reason, mirroring the tenant_void_reasons philosophy EXACTLY (0025/0026):
--   * adjustment_reason_kinds — fixed platform vocabulary (tenants never
--     mutate it; guard trigger + REVOKE + SELECT-only app grants);
--   * tenant_adjustment_reasons — a tenant's own free-form reasons, each with
--     a MANDATORY FK to a platform kind + a per-tenant is_enabled switch;
--   * tenant_adjustment_reason_kind_settings — per-tenant per-kind
--     disable-instead-of-delete (history is never rewritten).
-- Deliberate OMISSION vs void: no required_permission_tier column — no
-- inventory tier ladder exists (adjustments need the flat sensitive
-- 'inventory:adjust' key), and inventing one here would break the mirror.
-- Reason ENABLED-ness is engine-side (void mirror: validate_order_void does
-- not check it either); reason PRESENCE is structural (CHECKs below) and
-- reason EXISTENCE/tenant-match is the FK.
--
-- Grandfathering: pre-existing manual_adjustment rows keep NULL (no backfill
-- — rewriting audit history is forbidden); every NEW manual_adjustment row
-- must carry a reason, and every non-manual row must carry none.
--
-- Style notes: idempotent (IF NOT EXISTS / DROP IF EXISTS + ADD), no DROP
-- TABLE / CASCADE, mandatory RLS template on tenant tables, reference-data
-- seed ON CONFLICT DO NOTHING (0025 precedent).

-- ── (1) platform kinds ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS adjustment_reason_kinds (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_platform_adjustment_reason_kind_write ON adjustment_reason_kinds;
CREATE TRIGGER trg_platform_adjustment_reason_kind_write BEFORE INSERT OR UPDATE OR DELETE ON adjustment_reason_kinds
  FOR EACH ROW EXECUTE FUNCTION guard_platform_order_write();

REVOKE ALL ON adjustment_reason_kinds FROM PUBLIC;

INSERT INTO adjustment_reason_kinds (code, name) VALUES
  ('count_correction', '{"ar":"تصحيح جرد","en":"Count correction"}'),
  ('damage', '{"ar":"تالف","en":"Damage"}'),
  ('expiry', '{"ar":"منتهي الصلاحية","en":"Expiry"}'),
  ('shrinkage', '{"ar":"عجز","en":"Shrinkage"}'),
  ('other', '{"ar":"أخرى","en":"Other"}')
ON CONFLICT (code) DO NOTHING;

-- ── (2) tenant reasons ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_adjustment_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  adjustment_reason_kind_code text NOT NULL REFERENCES adjustment_reason_kinds (code) ON DELETE RESTRICT,
  label text NOT NULL CHECK (btrim(label) <> ''),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- stock_movements references these rows with ON DELETE RESTRICT: a reason
  -- used in history can never be deleted.
  CONSTRAINT tenant_adjustment_reasons_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT tenant_adjustment_reasons_tenant_label UNIQUE (tenant_id, label)
);
CREATE INDEX IF NOT EXISTS idx_tenant_adjustment_reasons_tenant_id ON tenant_adjustment_reasons (tenant_id);

ALTER TABLE tenant_adjustment_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_adjustment_reasons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_adjustment_reasons;
CREATE POLICY tenant_isolation ON tenant_adjustment_reasons
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ── (3) per-tenant kind settings ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_adjustment_reason_kind_settings (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  adjustment_reason_kind_code text NOT NULL REFERENCES adjustment_reason_kinds (code) ON DELETE RESTRICT,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, adjustment_reason_kind_code)
);

ALTER TABLE tenant_adjustment_reason_kind_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_adjustment_reason_kind_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_adjustment_reason_kind_settings;
CREATE POLICY tenant_isolation ON tenant_adjustment_reason_kind_settings
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE ALL ON tenant_adjustment_reasons, tenant_adjustment_reason_kind_settings FROM PUBLIC;

-- ── (4) the movement link + structural presence ───────────────────────
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS adjustment_reason_id uuid NULL;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_adjustment_reason_fk;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_adjustment_reason_fk
  FOREIGN KEY (adjustment_reason_id, tenant_id) REFERENCES tenant_adjustment_reasons (id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_manual_adjustment_reason_required;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_manual_adjustment_reason_required CHECK (
  movement_type <> 'manual_adjustment' OR adjustment_reason_id IS NOT NULL);
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_non_manual_reason_forbidden;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_non_manual_reason_forbidden CHECK (
  movement_type = 'manual_adjustment' OR adjustment_reason_id IS NULL);
