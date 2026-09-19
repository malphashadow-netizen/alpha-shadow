-- DD-005 phase 1a records receipt-cost facts and their rebuildable FIFO layers.
-- Identity values give a database-owned, insertion-order FIFO key; a manually
-- managed sequence could be advanced independently of the recorded receipt.
-- Inventory items already identify their branch, so duplicating branch_id here
-- would create a second source of truth. Costs use integer minor units to avoid
-- fractional-price drift. The partial index contains only allocable layers.

CREATE TABLE IF NOT EXISTS inventory_cost_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  inventory_item_id uuid NOT NULL,
  stock_movement_id uuid NOT NULL,
  total_cost_minor bigint NOT NULL CHECK (total_cost_minor > 0),
  original_qty NUMERIC(18,4) NOT NULL CHECK (original_qty > 0),
  currency_code text NOT NULL REFERENCES currencies (code),
  minor_unit_digits smallint NOT NULL CHECK (minor_unit_digits BETWEEN 0 AND 4),
  is_provisional boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_cost_ledger_id_tenant_key
    UNIQUE (id, tenant_id),
  CONSTRAINT inventory_cost_ledger_id_item_tenant_key
    UNIQUE (id, inventory_item_id, tenant_id),
  CONSTRAINT inventory_cost_ledger_movement_once
    UNIQUE (tenant_id, stock_movement_id),
  CONSTRAINT inventory_cost_ledger_movement_fk
    FOREIGN KEY (stock_movement_id, tenant_id)
    REFERENCES stock_movements (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT inventory_cost_ledger_item_fk
    FOREIGN KEY (inventory_item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS inventory_cost_layers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  inventory_item_id uuid NOT NULL,
  cost_ledger_id bigint NOT NULL,
  original_qty NUMERIC(18,4) NOT NULL CHECK (original_qty > 0),
  remaining_qty NUMERIC(18,4) NOT NULL CHECK (remaining_qty >= 0),
  total_cost_minor bigint NOT NULL CHECK (total_cost_minor > 0),
  remaining_cost_minor bigint NOT NULL CHECK (remaining_cost_minor >= 0),
  currency_code text NOT NULL REFERENCES currencies (code),
  minor_unit_digits smallint NOT NULL CHECK (minor_unit_digits BETWEEN 0 AND 4),
  is_provisional boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_cost_layers_remaining_qty_bounded
    CHECK (remaining_qty <= original_qty),
  CONSTRAINT inventory_cost_layers_remaining_cost_bounded
    CHECK (remaining_cost_minor <= total_cost_minor),
  CONSTRAINT inventory_cost_layers_no_orphan_cost
    CHECK (remaining_qty > 0 OR remaining_cost_minor = 0),
  CONSTRAINT inventory_cost_layers_id_tenant_key
    UNIQUE (id, tenant_id),
  CONSTRAINT inventory_cost_layers_ledger_once
    UNIQUE (tenant_id, cost_ledger_id),
  -- The composite reference proves a layer cannot silently name another item's ledger.
  CONSTRAINT inventory_cost_layers_ledger_item_fk
    FOREIGN KEY (cost_ledger_id, inventory_item_id, tenant_id)
    REFERENCES inventory_cost_ledger (id, inventory_item_id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT inventory_cost_layers_item_fk
    FOREIGN KEY (inventory_item_id, tenant_id)
    REFERENCES inventory_items (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_cost_ledger_tenant_id
  ON inventory_cost_ledger (tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_cost_ledger_item
  ON inventory_cost_ledger (tenant_id, inventory_item_id, id);
CREATE INDEX IF NOT EXISTS idx_inventory_cost_layers_tenant_id
  ON inventory_cost_layers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_cost_layers_fifo
  ON inventory_cost_layers (tenant_id, inventory_item_id, id)
  WHERE remaining_qty > 0;

ALTER TABLE inventory_cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cost_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_cost_ledger;
CREATE POLICY tenant_isolation ON inventory_cost_ledger
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE inventory_cost_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cost_layers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_cost_layers;
CREATE POLICY tenant_isolation ON inventory_cost_layers
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION guard_inventory_cost_ledger_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base_currency_code text;
  v_minor_unit_digits smallint;
  v_inventory_item_id uuid;
  v_quantity_delta numeric(18,4);
BEGIN
  -- stock_movements has no unique item-bearing key, so this trigger validates
  -- the movement's item without requiring a migration change to that ledger.
  SELECT inventory_item_id, quantity_delta
    INTO v_inventory_item_id, v_quantity_delta
    FROM stock_movements
   WHERE id = NEW.stock_movement_id
     AND tenant_id = NEW.tenant_id;

  IF v_inventory_item_id IS DISTINCT FROM NEW.inventory_item_id THEN
    RAISE EXCEPTION 'inventory_cost_ledger movement item must match ledger item: % is forbidden', TG_OP
      USING ERRCODE = '42501';
  END IF;

  IF v_quantity_delta = 0 THEN
    RAISE EXCEPTION 'inventory_cost_ledger zero quantity movement is forbidden: %', TG_OP
      USING ERRCODE = '42501';
  END IF;

  -- A receipt is costed in full: the layer IS the movement.
  IF v_quantity_delta > 0 AND NEW.original_qty IS DISTINCT FROM v_quantity_delta THEN
    RAISE EXCEPTION 'inventory_cost_ledger original_qty must match stock movement quantity: %', TG_OP
      USING ERRCODE = '42501';
  END IF;

  -- A negative movement is a sale into shortage. Only the SHORTFALL becomes a
  -- provisional layer; the covered part is consumed from existing real layers.
  -- The shortfall can never exceed the deduction itself.
  IF v_quantity_delta < 0 AND NEW.original_qty > abs(v_quantity_delta) THEN
    RAISE EXCEPTION 'inventory_cost_ledger provisional original_qty cannot exceed the stock movement quantity: %', TG_OP
      USING ERRCODE = '42501';
  END IF;

  -- A negative movement is a provisional shortage-sale layer (phase 2).
  -- A positive movement is a real receipt.
  IF v_quantity_delta > 0 AND NEW.is_provisional = true THEN
    RAISE EXCEPTION 'inventory_cost_ledger positive movement cannot be provisional: %', TG_OP
      USING ERRCODE = '42501';
  END IF;

  IF v_quantity_delta < 0 AND NEW.is_provisional = false THEN
    RAISE EXCEPTION 'inventory_cost_ledger negative movement must be provisional: %', TG_OP
      USING ERRCODE = '42501';
  END IF;

  SELECT b.base_currency, c.minor_unit_digits
    INTO v_base_currency_code, v_minor_unit_digits
    FROM inventory_items i
    JOIN branches b
      ON b.id = i.branch_id
     AND b.tenant_id = i.tenant_id
    JOIN currencies c
      ON c.code = b.base_currency
   WHERE i.id = NEW.inventory_item_id
     AND i.tenant_id = NEW.tenant_id;

  IF v_base_currency_code IS NULL
     OR v_base_currency_code IS DISTINCT FROM NEW.currency_code
     OR v_minor_unit_digits IS DISTINCT FROM NEW.minor_unit_digits THEN
    RAISE EXCEPTION 'inventory_cost_ledger currency must match branch base currency: % is forbidden', TG_OP
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_inventory_cost_layer_ledger_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_original_qty numeric(18,4);
  v_total_cost_minor bigint;
  v_currency_code text;
  v_minor_unit_digits smallint;
  v_is_provisional boolean;
BEGIN
  -- Consumption goes through the allocation path alone (the decrementing UPDATE).
  IF NEW.remaining_qty IS DISTINCT FROM NEW.original_qty
     OR NEW.remaining_cost_minor IS DISTINCT FROM NEW.total_cost_minor THEN
    RAISE EXCEPTION 'inventory_cost_layers layer must be created unconsumed: % is forbidden', TG_OP
      USING ERRCODE = '42501';
  END IF;

  SELECT original_qty, total_cost_minor, currency_code, minor_unit_digits, is_provisional
    INTO v_original_qty, v_total_cost_minor, v_currency_code, v_minor_unit_digits, v_is_provisional
   FROM inventory_cost_ledger
   WHERE id = NEW.cost_ledger_id
     AND tenant_id = NEW.tenant_id;

  IF v_original_qty IS DISTINCT FROM NEW.original_qty
     OR v_total_cost_minor IS DISTINCT FROM NEW.total_cost_minor
     OR v_currency_code IS DISTINCT FROM NEW.currency_code
     OR v_minor_unit_digits IS DISTINCT FROM NEW.minor_unit_digits
     OR v_is_provisional IS DISTINCT FROM NEW.is_provisional THEN
    RAISE EXCEPTION 'inventory_cost_layers must match ledger receipt facts including is_provisional: % is forbidden', TG_OP
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_inventory_cost_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_cost_ledger is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55006';
END;
$$;

CREATE OR REPLACE FUNCTION guard_inventory_cost_layer_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
     OR NEW.cost_ledger_id IS DISTINCT FROM OLD.cost_ledger_id
     OR NEW.original_qty IS DISTINCT FROM OLD.original_qty
     OR NEW.total_cost_minor IS DISTINCT FROM OLD.total_cost_minor
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.minor_unit_digits IS DISTINCT FROM OLD.minor_unit_digits THEN
    RAISE EXCEPTION 'inventory_cost_layers immutable fields: % is forbidden', TG_OP
      USING ERRCODE = '42501';
  END IF;
  IF NEW.remaining_qty > OLD.remaining_qty
     OR NEW.remaining_cost_minor > OLD.remaining_cost_minor THEN
    RAISE EXCEPTION 'inventory_cost_layers remaining values may only decrease: % is forbidden', TG_OP
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_inventory_cost_layer_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_cost_layers is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55006';
END;
$$;

DROP TRIGGER IF EXISTS trg_cost_ledger_currency ON inventory_cost_ledger;
CREATE TRIGGER trg_cost_ledger_currency
  BEFORE INSERT ON inventory_cost_ledger
  FOR EACH ROW
  EXECUTE FUNCTION guard_inventory_cost_ledger_currency();
DROP TRIGGER IF EXISTS trg_cost_ledger_immutable ON inventory_cost_ledger;
CREATE TRIGGER trg_cost_ledger_immutable
  BEFORE UPDATE OR DELETE ON inventory_cost_ledger
  FOR EACH ROW
  EXECUTE FUNCTION guard_inventory_cost_ledger_immutable();
DROP TRIGGER IF EXISTS trg_cost_layer_ledger_consistency ON inventory_cost_layers;
CREATE TRIGGER trg_cost_layer_ledger_consistency
  BEFORE INSERT ON inventory_cost_layers
  FOR EACH ROW
  EXECUTE FUNCTION guard_inventory_cost_layer_ledger_consistency();
DROP TRIGGER IF EXISTS trg_cost_layer_writes ON inventory_cost_layers;
CREATE TRIGGER trg_cost_layer_writes
  BEFORE UPDATE ON inventory_cost_layers
  FOR EACH ROW
  EXECUTE FUNCTION guard_inventory_cost_layer_writes();
DROP TRIGGER IF EXISTS trg_cost_layer_delete ON inventory_cost_layers;
CREATE TRIGGER trg_cost_layer_delete
  BEFORE DELETE ON inventory_cost_layers
  FOR EACH ROW
  EXECUTE FUNCTION guard_inventory_cost_layer_delete();

REVOKE ALL ON inventory_cost_ledger, inventory_cost_layers FROM PUBLIC;
