-- DD-005 phase 4c: PostgreSQL UUID aggregate compatibility and accurate restoration line labels.
CREATE OR REPLACE FUNCTION post_inventory_consumption(p_tenant uuid, p_order uuid, p_branch uuid, p_posted_by uuid, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_movement record; v_layer record; v_needed_units bigint; v_take_units bigint; v_layer_units bigint;
  v_allocated_qty numeric(18,4); v_allocated_cost bigint; v_total_cost bigint := 0;
  v_last_cost bigint; v_last_units bigint; v_ledger_id bigint; v_layer_id bigint;
  v_currency text; v_digits smallint; v_debit uuid; v_credit uuid; v_entry uuid;
  v_debit_count bigint; v_credit_count bigint;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'inventory consumption tenant must match current tenant' USING ERRCODE = '42501';
  END IF;
  FOR v_movement IN SELECT sm.id, sm.inventory_item_id, sm.order_item_id, abs(sm.quantity_delta) AS qty
    FROM stock_movements sm WHERE sm.tenant_id = p_tenant AND sm.order_id = p_order AND sm.branch_id = p_branch
      AND sm.movement_type = 'sale_deduction' AND NOT EXISTS
        (SELECT 1 FROM consumption_allocations ca WHERE ca.tenant_id = sm.tenant_id AND ca.stock_movement_id = sm.id)
    ORDER BY sm.created_at, sm.id
  LOOP
    v_needed_units := (v_movement.qty * 10000)::bigint;
    FOR v_layer IN SELECT * FROM inventory_cost_layers
      WHERE tenant_id = p_tenant AND inventory_item_id = v_movement.inventory_item_id AND remaining_qty > 0 ORDER BY created_at, id FOR UPDATE
    LOOP
      EXIT WHEN v_needed_units = 0;
      v_layer_units := (v_layer.remaining_qty * 10000)::bigint;
      v_take_units := least(v_needed_units, v_layer_units);
      v_allocated_qty := v_take_units::numeric / 10000;
      IF v_take_units = v_layer_units THEN
        v_allocated_cost := v_layer.remaining_cost_minor; v_allocated_qty := v_layer.remaining_qty;
      ELSE
        v_allocated_cost := (v_layer.remaining_cost_minor * v_take_units) / v_layer_units;
      END IF;
      INSERT INTO consumption_allocations (tenant_id, stock_movement_id, layer_id, order_item_id, qty, allocated_cost_minor, is_provisional)
      VALUES (p_tenant, v_movement.id, v_layer.id, v_movement.order_item_id, v_allocated_qty, v_allocated_cost, v_layer.is_provisional);
      UPDATE inventory_cost_layers SET remaining_qty = remaining_qty - v_allocated_qty,
        remaining_cost_minor = remaining_cost_minor - v_allocated_cost WHERE id = v_layer.id AND tenant_id = p_tenant;
      v_total_cost := v_total_cost + v_allocated_cost; v_needed_units := v_needed_units - v_take_units;
    END LOOP;
    IF v_needed_units > 0 THEN
      SELECT total_cost_minor, (original_qty * 10000)::bigint, currency_code, minor_unit_digits
      INTO v_last_cost, v_last_units, v_currency, v_digits FROM inventory_cost_layers
      WHERE tenant_id = p_tenant AND inventory_item_id = v_movement.inventory_item_id ORDER BY created_at DESC, id DESC LIMIT 1;
      IF v_last_units IS NULL OR v_last_units = 0 THEN
        INSERT INTO consumption_allocations (tenant_id, stock_movement_id, layer_id, order_item_id, qty, allocated_cost_minor, is_provisional)
        VALUES (p_tenant, v_movement.id, NULL, v_movement.order_item_id, v_needed_units::numeric / 10000, 0, true);
      ELSE
        v_allocated_cost := (v_last_cost * v_needed_units) / v_last_units;
        INSERT INTO inventory_cost_ledger (tenant_id, inventory_item_id, stock_movement_id, total_cost_minor, original_qty, currency_code, minor_unit_digits, is_provisional)
        VALUES (p_tenant, v_movement.inventory_item_id, v_movement.id, v_allocated_cost, v_needed_units::numeric / 10000, v_currency, v_digits, true)
        RETURNING id INTO v_ledger_id;
        INSERT INTO inventory_cost_layers (tenant_id, inventory_item_id, cost_ledger_id, original_qty, remaining_qty, total_cost_minor, remaining_cost_minor, currency_code, minor_unit_digits, is_provisional)
        VALUES (p_tenant, v_movement.inventory_item_id, v_ledger_id, v_needed_units::numeric / 10000, v_needed_units::numeric / 10000, v_allocated_cost, v_allocated_cost, v_currency, v_digits, true)
        RETURNING id INTO v_layer_id;
        INSERT INTO consumption_allocations (tenant_id, stock_movement_id, layer_id, order_item_id, qty, allocated_cost_minor, is_provisional)
        VALUES (p_tenant, v_movement.id, v_layer_id, v_movement.order_item_id, v_needed_units::numeric / 10000, v_allocated_cost, true);
        UPDATE inventory_cost_layers SET remaining_qty = 0, remaining_cost_minor = 0 WHERE id = v_layer_id AND tenant_id = p_tenant;
        v_total_cost := v_total_cost + v_allocated_cost;
      END IF;
    END IF;
    IF (SELECT COALESCE(sum(qty), 0) FROM consumption_allocations
         WHERE tenant_id = p_tenant AND stock_movement_id = v_movement.id)
       IS DISTINCT FROM v_movement.qty THEN
      RAISE EXCEPTION 'stock quantity and consumption allocations are inconsistent' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF v_total_cost = 0 THEN
    INSERT INTO audit_log (tenant_id, user_id, action, resource, "after") VALUES
      (p_tenant, p_posted_by, 'inventory:consumption_zero_cost', 'orders:' || p_order::text, jsonb_build_object('order_id', p_order));
    RETURN;
  END IF;
  SELECT min(id::text)::uuid, count(*) INTO v_debit, v_debit_count FROM accounts WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'cost_of_goods_in_process';
  SELECT min(id::text)::uuid, count(*) INTO v_credit, v_credit_count FROM accounts WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'inventory_asset';
  IF v_debit_count <> 1 OR v_credit_count <> 1 THEN RAISE EXCEPTION 'inventory consumption accounts are missing or ambiguous' USING ERRCODE = '23514'; END IF;
  INSERT INTO journal_entries (tenant_id, branch_id, accounting_date, occurred_at, source_type, source_id, currency_code, description, posted_by, posted_at)
  SELECT p_tenant, p_branch, (p_occurred_at AT TIME ZONE b.timezone)::date, p_occurred_at, 'inventory_consumption', p_order,
    b.base_currency, 'Inventory consumption ' || p_order::text, p_posted_by, p_occurred_at FROM branches b WHERE b.id = p_branch AND b.tenant_id = p_tenant
  ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING RETURNING id INTO v_entry;
  IF v_entry IS NOT NULL THEN
    INSERT INTO journal_entry_lines (tenant_id, journal_entry_id, line_number, account_id, debit_minor, credit_minor, description)
    VALUES (p_tenant, v_entry, 1, v_debit, v_total_cost, 0, 'Cost of goods in process'),
           (p_tenant, v_entry, 2, v_credit, 0, v_total_cost, 'Inventory asset');
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION post_inventory_restoration(p_tenant uuid, p_movement uuid, p_posted_by uuid, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_movement record; v_allocation record; v_disposition text;
  v_total_cost bigint := 0; v_debit uuid; v_credit uuid; v_entry uuid;
  v_debit_count bigint; v_credit_count bigint; v_inserted bigint;
  v_order_cogs_posted boolean;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'inventory restoration tenant must match current tenant' USING ERRCODE = '42501';
  END IF;

  SELECT sm.id, sm.branch_id, sm.inventory_item_id, sm.order_item_id, sm.order_id, sm.movement_type,
         oi.is_voided, b.base_currency, b.timezone
    INTO v_movement
    FROM stock_movements sm
    JOIN order_items oi ON oi.id = sm.order_item_id AND oi.tenant_id = sm.tenant_id
    JOIN branches b ON b.id = sm.branch_id AND b.tenant_id = sm.tenant_id
   WHERE sm.tenant_id = p_tenant AND sm.id = p_movement
     AND sm.movement_type IN ('void_restoration', 'waste_void', 'waste_refund');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory restoration requires a restoration or waste movement' USING ERRCODE = '23514';
  END IF;

  IF v_movement.movement_type = 'waste_void' THEN
    IF NOT v_movement.is_voided THEN
      RAISE EXCEPTION 'waste_void cost reclassification requires a voided order line' USING ERRCODE = '23514';
    END IF;
    v_disposition := 'waste_void';
  ELSIF v_movement.movement_type = 'waste_refund' THEN
    IF v_movement.is_voided THEN
      RAISE EXCEPTION 'waste_refund cost reclassification requires a live order line' USING ERRCODE = '23514';
    END IF;
    v_disposition := 'waste_refund';
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

  SELECT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE tenant_id = p_tenant
       AND source_type = 'order_cogs'
       AND source_id = v_movement.order_id
  ) INTO v_order_cogs_posted;

  IF v_movement.movement_type IN ('waste_void', 'waste_refund') THEN
    SELECT min(id::text)::uuid, count(*) INTO v_debit, v_debit_count FROM accounts
      WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'waste_expense';
  ELSE
    SELECT min(id::text)::uuid, count(*) INTO v_debit, v_debit_count FROM accounts
      WHERE tenant_id = p_tenant AND is_active AND system_purpose = 'inventory_asset';
  END IF;
  SELECT min(id::text)::uuid, count(*) INTO v_credit, v_credit_count FROM accounts
    WHERE tenant_id = p_tenant AND is_active
      AND system_purpose = CASE WHEN v_order_cogs_posted THEN 'cost_of_goods_sold' ELSE 'cost_of_goods_in_process' END;
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
       CASE WHEN v_movement.movement_type IN ('waste_void', 'waste_refund') THEN 'Waste expense' ELSE 'Inventory asset' END),
      (p_tenant, v_entry, 2, v_credit, 0, v_total_cost, CASE WHEN v_order_cogs_posted THEN 'Cost of goods sold' ELSE 'Cost of goods in process' END);
  ELSIF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE tenant_id = p_tenant AND source_type = 'inventory_restoration' AND source_id = p_movement) THEN
    RAISE EXCEPTION 'inventory restoration journal could not be posted' USING ERRCODE = '23514';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION post_inventory_consumption(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION post_inventory_restoration(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
