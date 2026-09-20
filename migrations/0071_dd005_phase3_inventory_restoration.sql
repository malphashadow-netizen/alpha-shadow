-- DD-005 phase 3: immutable cost restoration/reclassification evidence.
ALTER TABLE consumption_allocations
  ADD CONSTRAINT consumption_allocations_id_tenant_unique UNIQUE (id, tenant_id);

CREATE TABLE IF NOT EXISTS restoration_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  restoration_stock_movement_id uuid NOT NULL,
  original_consumption_allocation_id bigint NOT NULL,
  layer_id bigint,
  order_item_id uuid NOT NULL,
  qty numeric(18,4) NOT NULL CHECK (qty < 0),
  restored_cost_minor bigint NOT NULL CHECK (restored_cost_minor >= 0),
  disposition text NOT NULL CHECK (disposition IN ('void_restoration', 'refund_restoration', 'waste_void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, restoration_stock_movement_id, original_consumption_allocation_id),
  UNIQUE (tenant_id, original_consumption_allocation_id),
  FOREIGN KEY (restoration_stock_movement_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (original_consumption_allocation_id, tenant_id) REFERENCES consumption_allocations (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (layer_id, tenant_id) REFERENCES inventory_cost_layers (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id, tenant_id) REFERENCES order_items (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_restoration_allocations_movement ON restoration_allocations (tenant_id, restoration_stock_movement_id);

ALTER TABLE restoration_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE restoration_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON restoration_allocations FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION prevent_restoration_allocation_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'restoration_allocations is immutable accounting evidence: % is forbidden', TG_OP USING ERRCODE = '55006';
END;
$$;
CREATE TRIGGER trg_restoration_allocations_immutable BEFORE UPDATE OR DELETE ON restoration_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_restoration_allocation_mutation();

-- Phase 1 allowed layers to decrease only. Phase 3 permits an increase only
-- up to the immutable allocation projection, so neither a replay nor a direct
-- UPDATE can restore more quantity or cost than the recorded evidence.
CREATE OR REPLACE FUNCTION guard_inventory_cost_layer_writes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_max_qty numeric(18,4); v_max_cost bigint;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
     OR NEW.cost_ledger_id IS DISTINCT FROM OLD.cost_ledger_id
     OR NEW.original_qty IS DISTINCT FROM OLD.original_qty
     OR NEW.total_cost_minor IS DISTINCT FROM OLD.total_cost_minor
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.minor_unit_digits IS DISTINCT FROM OLD.minor_unit_digits THEN
    RAISE EXCEPTION 'inventory_cost_layers immutable fields: % is forbidden', TG_OP USING ERRCODE = '42501';
  END IF;
  IF NEW.remaining_qty > OLD.remaining_qty OR NEW.remaining_cost_minor > OLD.remaining_cost_minor THEN
    SELECT NEW.original_qty - COALESCE(sum(ca.qty), 0)
             - COALESCE(sum(ra.qty) FILTER (WHERE ra.disposition <> 'waste_void'), 0),
           NEW.total_cost_minor - COALESCE(sum(ca.allocated_cost_minor), 0)
             + COALESCE(sum(ra.restored_cost_minor) FILTER (WHERE ra.disposition <> 'waste_void'), 0)
      INTO v_max_qty, v_max_cost
      FROM consumption_allocations ca
      LEFT JOIN restoration_allocations ra
        ON ra.tenant_id = ca.tenant_id AND ra.original_consumption_allocation_id = ca.id
     WHERE ca.tenant_id = NEW.tenant_id AND ca.layer_id = NEW.id;
    IF NEW.remaining_qty > v_max_qty OR NEW.remaining_cost_minor > v_max_cost THEN
      RAISE EXCEPTION 'inventory_cost_layers restoration exceeds immutable allocation evidence: % is forbidden', TG_OP USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION post_inventory_restoration(p_tenant uuid, p_movement uuid, p_posted_by uuid, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_movement record; v_allocation record; v_disposition text;
  v_total_cost bigint := 0; v_debit uuid; v_credit uuid; v_entry uuid;
  v_debit_count bigint; v_credit_count bigint; v_inserted bigint;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'inventory restoration tenant must match current tenant' USING ERRCODE = '42501';
  END IF;

  SELECT sm.id, sm.branch_id, sm.inventory_item_id, sm.order_item_id, sm.movement_type,
         oi.is_voided, b.base_currency, b.timezone
    INTO v_movement
    FROM stock_movements sm
    JOIN order_items oi ON oi.id = sm.order_item_id AND oi.tenant_id = sm.tenant_id
    JOIN branches b ON b.id = sm.branch_id AND b.tenant_id = sm.tenant_id
   WHERE sm.tenant_id = p_tenant AND sm.id = p_movement
     AND sm.movement_type IN ('void_restoration', 'waste_void');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory restoration requires a restoration or void-waste movement' USING ERRCODE = '23514';
  END IF;

  IF v_movement.movement_type = 'waste_void' THEN
    IF NOT v_movement.is_voided THEN
      RAISE EXCEPTION 'waste_void cost reclassification requires a voided order line' USING ERRCODE = '23514';
    END IF;
    v_disposition := 'waste_void';
  ELSIF v_movement.is_voided THEN
    v_disposition := 'void_restoration';
  ELSE
    v_disposition := 'refund_restoration';
  END IF;

  FOR v_allocation IN
    SELECT ca.id, ca.layer_id, ca.order_item_id, ca.qty, ca.allocated_cost_minor
      FROM consumption_allocations ca
      JOIN stock_movements consumed ON consumed.id = ca.stock_movement_id AND consumed.tenant_id = ca.tenant_id
     WHERE ca.tenant_id = p_tenant
       AND ca.order_item_id = v_movement.order_item_id
       AND consumed.inventory_item_id = v_movement.inventory_item_id
       AND NOT EXISTS (
         SELECT 1 FROM restoration_allocations ra
          WHERE ra.tenant_id = ca.tenant_id
            AND ra.original_consumption_allocation_id = ca.id)
     ORDER BY ca.id
  LOOP
    INSERT INTO restoration_allocations
      (tenant_id, restoration_stock_movement_id, original_consumption_allocation_id,
       layer_id, order_item_id, qty, restored_cost_minor, disposition)
    VALUES
      (p_tenant, p_movement, v_allocation.id, v_allocation.layer_id,
       v_allocation.order_item_id, -v_allocation.qty, v_allocation.allocated_cost_minor, v_disposition)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_inserted;
    IF v_inserted IS NULL THEN CONTINUE; END IF;

    IF v_movement.movement_type = 'void_restoration' AND v_allocation.layer_id IS NOT NULL THEN
      UPDATE inventory_cost_layers
         SET remaining_qty = remaining_qty + v_allocation.qty,
             remaining_cost_minor = remaining_cost_minor + v_allocation.allocated_cost_minor
       WHERE tenant_id = p_tenant AND id = v_allocation.layer_id;
    END IF;
    v_total_cost := v_total_cost + v_allocation.allocated_cost_minor;
    v_inserted := NULL;
  END LOOP;

  IF v_total_cost = 0 THEN RETURN; END IF;

  IF v_movement.movement_type = 'waste_void' THEN
    SELECT min(id::text)::uuid, count(*) INTO v_debit, v_debit_count FROM accounts
      WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'waste_expense';
  ELSE
    SELECT min(id::text)::uuid, count(*) INTO v_debit, v_debit_count FROM accounts
      WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'inventory_asset';
  END IF;
  SELECT min(id::text)::uuid, count(*) INTO v_credit, v_credit_count FROM accounts
    WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'cost_of_goods_in_process';
  IF v_debit_count <> 1 OR v_credit_count <> 1 THEN
    RAISE EXCEPTION 'inventory restoration accounts are missing or ambiguous' USING ERRCODE = '23514';
  END IF;

  INSERT INTO journal_entries
    (tenant_id, branch_id, accounting_date, occurred_at, source_type, source_id,
     currency_code, description, posted_by, posted_at)
  VALUES
    (p_tenant, v_movement.branch_id, (p_occurred_at AT TIME ZONE v_movement.timezone)::date,
     p_occurred_at, 'inventory_restoration', p_movement, v_movement.base_currency,
     'Inventory restoration ' || p_movement::text, p_posted_by, p_occurred_at)
  ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING RETURNING id INTO v_entry;
  IF v_entry IS NOT NULL THEN
    INSERT INTO journal_entry_lines
      (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor, description)
    VALUES
      (p_tenant, v_entry, 1, v_debit, v_total_cost, 0,
       CASE WHEN v_movement.movement_type = 'waste_void' THEN 'Waste expense' ELSE 'Inventory asset' END),
      (p_tenant, v_entry, 2, v_credit, 0, v_total_cost, 'Cost of goods in process');
  ELSIF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE tenant_id = p_tenant AND source_type = 'inventory_restoration' AND source_id = p_movement) THEN
    RAISE EXCEPTION 'inventory restoration journal could not be posted' USING ERRCODE = '23514';
  END IF;
END;
$$;

REVOKE ALL ON restoration_allocations FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_restoration_allocation_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION post_inventory_restoration(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
