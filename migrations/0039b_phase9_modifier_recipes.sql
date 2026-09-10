-- Migration 0039b — Phase 9 (4/6): modifier_recipes + the recipe_ingredients view.
--
-- Modifiers carry their OWN independent recipes, deducted separately from the
-- base product's components. Same structure as menu_item_recipes (0039a) with
-- a REAL foreign key to modifiers — no polymorphic association.
--
-- The recipe_ingredients VIEW (UNION ALL over both tables) is the SINGLE read
-- source the OrderCreationEngine queries to aggregate every component of an
-- order (products + chosen modifiers) in one statement.
--
-- VIEW + RLS — READ THIS: a plain PostgreSQL view checks access to its
-- underlying tables as the VIEW OWNER (the migration role), which could
-- bypass row-level filtering. WITH (security_invoker = true) (PostgreSQL 15+;
-- this repo runs PostgreSQL 18) forces the caller's own privileges AND RLS
-- policies (FORCE + NOBYPASSRLS) on every underlying row. Cross-tenant
-- isolation through this view is additionally proven by an explicit live
-- test in the Phase-9 suite (the generic RLS contract only scans tables).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS modifier_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  modifier_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_required NUMERIC(18,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT modifier_recipes_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT modifier_recipes_unique UNIQUE (tenant_id, modifier_id, inventory_item_id),
  CONSTRAINT modifier_recipes_quantity_positive CHECK (quantity_required > 0),
  CONSTRAINT modifier_recipes_modifier_fk
    FOREIGN KEY (modifier_id, tenant_id)
    REFERENCES modifiers (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT modifier_recipes_component_fk
    FOREIGN KEY (inventory_item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_modifier_recipes_tenant_id ON modifier_recipes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifier_recipes_modifier ON modifier_recipes (tenant_id, modifier_id);

ALTER TABLE modifier_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_recipes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON modifier_recipes;
CREATE POLICY tenant_isolation ON modifier_recipes
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE VIEW recipe_ingredients WITH (security_invoker = true) AS
SELECT tenant_id, 'menu_item'::text AS owner_type, menu_item_id AS owner_id, inventory_item_id, quantity_required
  FROM public.menu_item_recipes
UNION ALL
SELECT tenant_id, 'modifier'::text AS owner_type, modifier_id AS owner_id, inventory_item_id, quantity_required
  FROM public.modifier_recipes;

REVOKE ALL ON modifier_recipes FROM PUBLIC;
REVOKE ALL ON recipe_ingredients FROM PUBLIC;
