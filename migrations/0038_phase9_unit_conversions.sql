-- Migration 0038 — Phase 9 (2/6): unit_conversions.
--
-- Tenant-level purchase-unit conversion factors per component: a component is
-- stocked in ONE base unit (inventory_items.base_unit) but may be purchased in
-- several units (bought by the kilo, consumed by the gram).
--
-- LOCKED semantics: qty_in_to_unit = qty_in_from_unit × conversion_factor
-- (e.g. from_unit 'kg', to_unit 'g', factor 1000).
--
-- LOCKED scope: this table is consulted ONLY at manual_receiving time (the
-- invoice/purchase unit is converted to the base unit BEFORE the movement row
-- is written). It is NEVER consulted on the OrderCreationEngine.create() hot
-- path — recipes store base-unit quantities directly, so deduction is a
-- multiply-and-subtract with no conversion step.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  inventory_item_id uuid NOT NULL,
  from_unit text NOT NULL,
  to_unit text NOT NULL,
  conversion_factor NUMERIC(18,8) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_conversions_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT unit_conversions_unique UNIQUE (tenant_id, inventory_item_id, from_unit, to_unit),
  CONSTRAINT unit_conversions_units_nonempty
    CHECK (char_length(from_unit) BETWEEN 1 AND 32 AND char_length(to_unit) BETWEEN 1 AND 32),
  CONSTRAINT unit_conversions_factor_positive CHECK (conversion_factor > 0),
  CONSTRAINT unit_conversions_item_fk
    FOREIGN KEY (inventory_item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_unit_conversions_tenant_id ON unit_conversions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_unit_conversions_item ON unit_conversions (tenant_id, inventory_item_id);

ALTER TABLE unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_conversions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON unit_conversions;
CREATE POLICY tenant_isolation ON unit_conversions
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE ALL ON unit_conversions FROM PUBLIC;
