-- Migration 0039a — Phase 9 (3/6): menu_item_recipes.
--
-- The bill of materials of a menu item: which tracked components it consumes
-- and how much of each PER UNIT SOLD. A separate table per owner kind with
-- REAL foreign keys — never a polymorphic (owner_type, owner_id) association.
--
-- LOCKED rule: quantity_required is ALWAYS stored in the component's base
-- unit (inventory_items.base_unit) directly. No conversion happens at
-- deduction time; unit_conversions is a receiving-time concern only (0038).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS menu_item_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  menu_item_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_required NUMERIC(18,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT menu_item_recipes_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT menu_item_recipes_unique UNIQUE (tenant_id, menu_item_id, inventory_item_id),
  CONSTRAINT menu_item_recipes_quantity_positive CHECK (quantity_required > 0),
  CONSTRAINT menu_item_recipes_item_fk
    FOREIGN KEY (menu_item_id, tenant_id)
    REFERENCES menu_items (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT menu_item_recipes_component_fk
    FOREIGN KEY (inventory_item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_menu_item_recipes_tenant_id ON menu_item_recipes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_item_recipes_item ON menu_item_recipes (tenant_id, menu_item_id);

ALTER TABLE menu_item_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_recipes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON menu_item_recipes;
CREATE POLICY tenant_isolation ON menu_item_recipes
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE ALL ON menu_item_recipes FROM PUBLIC;
