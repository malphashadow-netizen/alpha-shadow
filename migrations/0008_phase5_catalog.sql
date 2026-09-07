-- Migration 0008 — Phase 5 dynamic catalog / menu engine.
--
-- Six tenant-scoped tables, each with the mandatory RLS template (ENABLE +
-- FORCE + tenant_isolation FOR ALL USING/WITH CHECK). Every FK that points at
-- a catalog row uses ON DELETE RESTRICT: referenced rows are never physically
-- deleted; the engine archives them with is_active = false.
--
-- Amounts are BIGINT minor units (never NUMERIC/float). Language fields are
-- free-key JSONB objects — there is NO language allow-list in SQL or in code.
-- tax_rule_id is a Phase-6 hook and has no FK in this migration.
--
-- Style notes (same conventions as 0003/0004/0006, enforced by
-- tools/check-migrations.ts and test/contract/rls-coverage.test.ts):
--   * Idempotent: CREATE … IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--     DROP POLICY IF EXISTS (re-creatable).
--   * NO `DROP TABLE` and NO `DROP … CASCADE`.
--   * Every table with a tenant_id column carries the mandatory RLS template.
--
-- The three catalog permission keys seeded at the bottom are GLOBAL registry
-- rows (permissions_registry has no tenant_id), identical in every environment.
-- ON CONFLICT DO NOTHING — never DO UPDATE.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) menu_categories
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name jsonb NOT NULL,
  parent_category_id uuid NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT menu_categories_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT menu_categories_name_object CHECK (jsonb_typeof(name) = 'object'),
  CONSTRAINT menu_categories_parent_fk
    FOREIGN KEY (parent_category_id, tenant_id)
    REFERENCES menu_categories (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_menu_categories_tenant_id ON menu_categories (tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_parent ON menu_categories (tenant_id, parent_category_id);

ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON menu_categories;
CREATE POLICY tenant_isolation ON menu_categories
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) menu_items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  category_id uuid NOT NULL,
  name jsonb NOT NULL,
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_price_amount_minor bigint NOT NULL,
  base_price_currency_code text NOT NULL,
  -- Phase-6 hook: no FK yet. Tax phase will
  --   ALTER TABLE menu_items ADD CONSTRAINT menu_items_tax_rule_id_fkey
  --     FOREIGN KEY (tax_rule_id) REFERENCES tax_rules (id);
  -- See docs/backlog.md.
  tax_rule_id uuid NULL,
  sku text NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  image_url text NULL,
  CONSTRAINT menu_items_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT menu_items_name_object CHECK (jsonb_typeof(name) = 'object'),
  CONSTRAINT menu_items_description_object CHECK (jsonb_typeof(description) = 'object'),
  CONSTRAINT menu_items_currency_iso_shape CHECK (base_price_currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT menu_items_currency_fk
    FOREIGN KEY (base_price_currency_code) REFERENCES currencies (code),
  CONSTRAINT menu_items_category_fk
    FOREIGN KEY (category_id, tenant_id)
    REFERENCES menu_categories (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_menu_items_tenant_id ON menu_items (tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items (tenant_id, category_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_tenant_sku
  ON menu_items (tenant_id, sku)
  WHERE sku IS NOT NULL;

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON menu_items;
CREATE POLICY tenant_isolation ON menu_items
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) branch_menu_item_overrides
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branch_menu_item_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  menu_item_id uuid NOT NULL,
  price_override_amount_minor bigint NULL,
  is_available boolean NOT NULL DEFAULT true,
  availability_schedule jsonb NULL,
  CONSTRAINT branch_menu_item_overrides_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT branch_menu_item_overrides_unique UNIQUE (tenant_id, branch_id, menu_item_id),
  CONSTRAINT branch_menu_item_overrides_schedule_object
    CHECK (availability_schedule IS NULL OR jsonb_typeof(availability_schedule) = 'object'),
  CONSTRAINT branch_menu_item_overrides_item_fk
    FOREIGN KEY (menu_item_id, tenant_id)
    REFERENCES menu_items (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_branch_menu_item_overrides_tenant_id ON branch_menu_item_overrides (tenant_id);
CREATE INDEX IF NOT EXISTS idx_branch_menu_item_overrides_branch ON branch_menu_item_overrides (tenant_id, branch_id);

ALTER TABLE branch_menu_item_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_menu_item_overrides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON branch_menu_item_overrides;
CREATE POLICY tenant_isolation ON branch_menu_item_overrides
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) modifier_groups
--     is_active is the mandatory soft-delete flag (no physical DELETE of a
--     referenced group). selection_type is a schema CHECK, not an application
--     language/catalog hardcode.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name jsonb NOT NULL,
  selection_type text NOT NULL,
  min_selections integer NOT NULL DEFAULT 0,
  max_selections integer NULL,
  is_required boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT modifier_groups_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT modifier_groups_name_object CHECK (jsonb_typeof(name) = 'object'),
  CONSTRAINT modifier_groups_selection_type_valid CHECK (selection_type IN ('single', 'multiple')),
  CONSTRAINT modifier_groups_min_selections_nonnegative CHECK (min_selections >= 0),
  CONSTRAINT modifier_groups_max_selections_nonnegative CHECK (max_selections IS NULL OR max_selections >= 0),
  CONSTRAINT modifier_groups_min_lte_max CHECK (max_selections IS NULL OR min_selections <= max_selections)
);

CREATE INDEX IF NOT EXISTS idx_modifier_groups_tenant_id ON modifier_groups (tenant_id);

ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON modifier_groups;
CREATE POLICY tenant_isolation ON modifier_groups
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (5) modifiers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  modifier_group_id uuid NOT NULL,
  name jsonb NOT NULL,
  price_delta_amount_minor bigint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT modifiers_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT modifiers_name_object CHECK (jsonb_typeof(name) = 'object'),
  CONSTRAINT modifiers_group_fk
    FOREIGN KEY (modifier_group_id, tenant_id)
    REFERENCES modifier_groups (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_modifiers_tenant_id ON modifiers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifiers_group ON modifiers (tenant_id, modifier_group_id);

ALTER TABLE modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifiers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON modifiers;
CREATE POLICY tenant_isolation ON modifiers
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- (6) menu_item_modifier_groups
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  menu_item_id uuid NOT NULL,
  modifier_group_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT menu_item_modifier_groups_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT menu_item_modifier_groups_unique UNIQUE (tenant_id, menu_item_id, modifier_group_id),
  CONSTRAINT menu_item_modifier_groups_item_fk
    FOREIGN KEY (menu_item_id, tenant_id)
    REFERENCES menu_items (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT menu_item_modifier_groups_group_fk
    FOREIGN KEY (modifier_group_id, tenant_id)
    REFERENCES modifier_groups (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_menu_item_modifier_groups_tenant_id ON menu_item_modifier_groups (tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_item_modifier_groups_item ON menu_item_modifier_groups (tenant_id, menu_item_id);

ALTER TABLE menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_modifier_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON menu_item_modifier_groups;
CREATE POLICY tenant_isolation ON menu_item_modifier_groups
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Global catalog permission keys (resource:action). Catalog edits are NOT
-- live money movement, so is_sensitive stays false — L1 cache applies.
INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('catalog:read', 'catalog', false),
  ('catalog:write', 'catalog', false),
  ('catalog:archive', 'catalog', false)
ON CONFLICT (key) DO NOTHING;
