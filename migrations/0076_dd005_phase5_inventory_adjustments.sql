-- DD-005 phase 5: cost manual inventory adjustments and post inventory variance.
CREATE TABLE IF NOT EXISTS adjustment_cost_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  stock_movement_id uuid NOT NULL,
  layer_id bigint NULL,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  allocated_cost_minor bigint NOT NULL CHECK (allocated_cost_minor >= 0),
  is_provisional boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adjustment_cost_allocations_movement_layer_unique UNIQUE NULLS NOT DISTINCT (tenant_id, stock_movement_id, layer_id),
  CONSTRAINT adjustment_cost_allocations_movement_fk FOREIGN KEY (stock_movement_id, tenant_id)
    REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT adjustment_cost_allocations_layer_fk FOREIGN KEY (layer_id, tenant_id)
    REFERENCES inventory_cost_layers (id, tenant_id) ON DELETE RESTRICT
);

ALTER TABLE adjustment_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE adjustment_cost_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON adjustment_cost_allocations FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION prevent_adjustment_cost_allocation_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'adjustment_cost_allocations is immutable accounting evidence: % is forbidden', TG_OP USING ERRCODE = '55006';
END;
$$;
CREATE TRIGGER trg_adjustment_cost_allocations_immutable
  BEFORE UPDATE OR DELETE ON adjustment_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_adjustment_cost_allocation_mutation();

CREATE FUNCTION post_inventory_adjustment(p_tenant uuid, p_movement uuid, p_posted_by uuid, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_movement record; v_layer record; v_needed_units bigint; v_take_units bigint; v_basis_units bigint;
  v_allocated_qty numeric(18,4); v_allocated_cost bigint; v_total_cost bigint := 0;
  v_basis_cost bigint; v_currency text; v_digits smallint; v_ledger_id bigint; v_layer_id bigint;
  v_debit uuid; v_credit uuid; v_entry uuid; v_debit_count bigint; v_credit_count bigint;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'inventory adjustment tenant must match current tenant' USING ERRCODE = '42501';
  END IF;

  SELECT sm.id, sm.branch_id, sm.inventory_item_id, sm.quantity_delta,
         r.adjustment_reason_kind_code AS kind_code
    INTO v_movement
    FROM stock_movements sm
    LEFT JOIN tenant_adjustment_reasons r
      ON r.tenant_id = sm.tenant_id AND r.id = sm.adjustment_reason_id
   WHERE sm.tenant_id = p_tenant AND sm.id = p_movement AND sm.movement_type = 'manual_adjustment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual inventory adjustment movement was not found' USING ERRCODE = '23514';
  END IF;
  -- Grandfathered rows can have no reason. They remain readable history but cannot be newly posted.
  IF v_movement.kind_code IS NULL THEN
    RAISE EXCEPTION 'manual inventory adjustment reason kind is required for posting' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE tenant_id = p_tenant AND source_type = 'inventory_adjustment' AND source_id = p_movement) THEN
    RETURN;
  END IF;

  v_needed_units := (abs(v_movement.quantity_delta) * 10000)::bigint;
  IF v_movement.quantity_delta > 0 THEN
    IF v_movement.kind_code <> 'count_correction' THEN
      -- DD-005 phase 5 defines positive valuation only for count corrections.
      -- Preserve the pre-existing behavior for other positive reason kinds until their accounting is specified.
      RETURN;
    END IF;
    SELECT remaining_cost_minor, (remaining_qty * 10000)::bigint, currency_code, minor_unit_digits
      INTO v_basis_cost, v_basis_units, v_currency, v_digits
      FROM inventory_cost_layers
     WHERE tenant_id = p_tenant AND inventory_item_id = v_movement.inventory_item_id
       AND remaining_qty > 0 AND is_provisional = false
     ORDER BY created_at, id LIMIT 1;
    IF v_basis_units IS NULL THEN
      SELECT l.total_cost_minor, (l.original_qty * 10000)::bigint, l.currency_code, l.minor_unit_digits
        INTO v_basis_cost, v_basis_units, v_currency, v_digits
        FROM inventory_cost_ledger l
        JOIN stock_movements sm ON sm.tenant_id = l.tenant_id AND sm.id = l.stock_movement_id
       WHERE l.tenant_id = p_tenant AND l.inventory_item_id = v_movement.inventory_item_id
         AND l.is_provisional = false AND sm.movement_type = 'manual_receiving'
       ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1;
    END IF;
    IF v_basis_units IS NULL OR v_basis_units = 0 THEN
      RAISE EXCEPTION 'count correction requires an explicit price because no real cost basis exists' USING ERRCODE = '23514';
    END IF;
    v_total_cost := (v_basis_cost * v_needed_units) / v_basis_units;
    IF v_total_cost <= 0 THEN
      RAISE EXCEPTION 'count correction requires an explicit price because its cost rounds to zero' USING ERRCODE = '23514';
    END IF;
    INSERT INTO inventory_cost_ledger
      (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits, is_provisional)
    VALUES
      (p_tenant, v_movement.inventory_item_id, p_movement, v_total_cost, v_movement.quantity_delta, v_currency, v_digits, false)
    RETURNING id INTO v_ledger_id;
    INSERT INTO inventory_cost_layers
      (tenant_id, inventory_item_id, cost_ledger_id, original_qty, remaining_qty, total_cost_minor, remaining_cost_minor, currency_code, minor_unit_digits, is_provisional)
    VALUES
      (p_tenant, v_movement.inventory_item_id, v_ledger_id, v_movement.quantity_delta, v_movement.quantity_delta,
       v_total_cost, v_total_cost, v_currency, v_digits, false);
  ELSE
    FOR v_layer IN SELECT * FROM inventory_cost_layers
      WHERE tenant_id = p_tenant AND inventory_item_id = v_movement.inventory_item_id AND remaining_qty > 0
      ORDER BY created_at, id FOR UPDATE
    LOOP
      EXIT WHEN v_needed_units = 0;
      v_basis_units := (v_layer.remaining_qty * 10000)::bigint;
      v_take_units := least(v_needed_units, v_basis_units);
      v_allocated_qty := v_take_units::numeric / 10000;
      IF v_take_units = v_basis_units THEN
        v_allocated_cost := v_layer.remaining_cost_minor;
        v_allocated_qty := v_layer.remaining_qty;
      ELSE
        v_allocated_cost := (v_layer.remaining_cost_minor * v_take_units) / v_basis_units;
      END IF;
      INSERT INTO adjustment_cost_allocations
        (tenant_id, stock_movement_id, layer_id, qty, allocated_cost_minor, is_provisional)
      VALUES (p_tenant, p_movement, v_layer.id, v_allocated_qty, v_allocated_cost, v_layer.is_provisional);
      UPDATE inventory_cost_layers
         SET remaining_qty = remaining_qty - v_allocated_qty,
             remaining_cost_minor = remaining_cost_minor - v_allocated_cost
       WHERE tenant_id = p_tenant AND id = v_layer.id;
      v_total_cost := v_total_cost + v_allocated_cost;
      v_needed_units := v_needed_units - v_take_units;
    END LOOP;
    IF v_needed_units > 0 THEN
      -- DD-005 phase 5 requires shortage-layer handling here but does not explicitly
      -- specify the valuation basis when a negative manual adjustment exceeds every
      -- real layer. This temporarily mirrors sale-deduction shortages: the latest
      -- layer may itself be provisional, so its estimated cost can chain into this
      -- new provisional shortfall. Track the unresolved policy in docs/backlog.md.
      SELECT total_cost_minor, (original_qty * 10000)::bigint, currency_code, minor_unit_digits
        INTO v_basis_cost, v_basis_units, v_currency, v_digits
        FROM inventory_cost_layers
       WHERE tenant_id = p_tenant AND inventory_item_id = v_movement.inventory_item_id
       ORDER BY created_at DESC, id DESC LIMIT 1;
      IF v_basis_units IS NULL OR v_basis_units = 0 THEN
        INSERT INTO adjustment_cost_allocations
          (tenant_id, stock_movement_id, layer_id, qty, allocated_cost_minor, is_provisional)
        VALUES (p_tenant, p_movement, NULL, v_needed_units::numeric / 10000, 0, true);
      ELSE
        v_allocated_cost := (v_basis_cost * v_needed_units) / v_basis_units;
        INSERT INTO inventory_cost_ledger
          (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits, is_provisional)
        VALUES
          (p_tenant, v_movement.inventory_item_id, p_movement, v_allocated_cost, v_needed_units::numeric / 10000,
           v_currency, v_digits, true)
        RETURNING id INTO v_ledger_id;
        INSERT INTO inventory_cost_layers
          (tenant_id, inventory_item_id, cost_ledger_id, original_qty, remaining_qty, total_cost_minor, remaining_cost_minor, currency_code, minor_unit_digits, is_provisional)
        VALUES
          (p_tenant, v_movement.inventory_item_id, v_ledger_id, v_needed_units::numeric / 10000,
           v_needed_units::numeric / 10000, v_allocated_cost, v_allocated_cost, v_currency, v_digits, true)
        RETURNING id INTO v_layer_id;
        INSERT INTO adjustment_cost_allocations
          (tenant_id, stock_movement_id, layer_id, qty, allocated_cost_minor, is_provisional)
        VALUES (p_tenant, p_movement, v_layer_id, v_needed_units::numeric / 10000, v_allocated_cost, true);
        UPDATE inventory_cost_layers SET remaining_qty = 0, remaining_cost_minor = 0
         WHERE tenant_id = p_tenant AND id = v_layer_id;
        v_total_cost := v_total_cost + v_allocated_cost;
      END IF;
    END IF;
  END IF;

  IF v_total_cost = 0 THEN
    INSERT INTO audit_log (tenant_id, user_id, action, resource, "after") VALUES
      (p_tenant, p_posted_by, 'inventory:adjustment_zero_cost', 'stock_movements:' || p_movement::text,
       jsonb_build_object('stock_movement_id', p_movement));
    RETURN;
  END IF;

  -- No current schema maps individual reason kinds to distinct accounts. Until that design exists,
  -- every negative manual adjustment uses Inventory Variance rather than silently guessing Waste Expense.
  SELECT min(id::text)::uuid, count(*) INTO v_debit, v_debit_count FROM accounts
   WHERE tenant_id = p_tenant AND is_active AND system_purpose = CASE
     WHEN v_movement.quantity_delta > 0 THEN 'inventory_asset' ELSE 'inventory_variance' END;
  SELECT min(id::text)::uuid, count(*) INTO v_credit, v_credit_count FROM accounts
   WHERE tenant_id = p_tenant AND is_active AND system_purpose = CASE
     WHEN v_movement.quantity_delta > 0 THEN 'inventory_variance' ELSE 'inventory_asset' END;
  IF v_debit_count <> 1 OR v_credit_count <> 1 THEN
    RAISE EXCEPTION 'inventory adjustment accounts are missing or ambiguous' USING ERRCODE = '23514';
  END IF;
  INSERT INTO journal_entries
    (tenant_id, branch_id, accounting_date, occurred_at, source_type, source_id, currency_code, description, posted_by, posted_at)
  SELECT p_tenant, v_movement.branch_id, (p_occurred_at AT TIME ZONE b.timezone)::date, p_occurred_at,
         'inventory_adjustment', p_movement, b.base_currency, 'Inventory adjustment ' || p_movement::text,
         p_posted_by, p_occurred_at
    FROM branches b WHERE b.tenant_id = p_tenant AND b.id = v_movement.branch_id
  ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING RETURNING id INTO v_entry;
  IF v_entry IS NOT NULL THEN
    INSERT INTO journal_entry_lines
      (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor, description)
    VALUES
      (p_tenant, v_entry, 1, v_debit, v_total_cost, 0,
       CASE WHEN v_movement.quantity_delta > 0 THEN 'Inventory asset' ELSE 'Inventory variance' END),
      (p_tenant, v_entry, 2, v_credit, 0, v_total_cost,
       CASE WHEN v_movement.quantity_delta > 0 THEN 'Inventory variance' ELSE 'Inventory asset' END);
  END IF;
END;
$$;

REVOKE ALL ON adjustment_cost_allocations FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_adjustment_cost_allocation_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION post_inventory_adjustment(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
