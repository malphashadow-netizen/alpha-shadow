-- DD-005 phase 4: move an order's net cost from WIP to COGS on full settlement.
CREATE FUNCTION post_order_cogs(
  p_tenant uuid,
  p_order uuid,
  p_posted_by uuid,
  p_occurred_at timestamptz
)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_branch uuid;
  v_currency text;
  v_timezone text;
  v_total_cost bigint;
  v_debit uuid;
  v_credit uuid;
  v_entry uuid;
  v_debit_count bigint;
  v_credit_count bigint;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'order COGS tenant must match current tenant' USING ERRCODE = '42501';
  END IF;

  SELECT o.branch_id, b.base_currency, b.timezone
    INTO v_branch, v_currency, v_timezone
    FROM orders o
    JOIN branches b ON b.id = o.branch_id AND b.tenant_id = o.tenant_id
   WHERE o.tenant_id = p_tenant AND o.id = p_order;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order COGS requires an existing order' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(ca.allocated_cost_minor), 0)
         - COALESCE(sum(ra.restored_cost_minor), 0)
    INTO v_total_cost
    FROM consumption_allocations ca
    JOIN stock_movements sm
      ON sm.id = ca.stock_movement_id AND sm.tenant_id = ca.tenant_id
    LEFT JOIN restoration_allocations ra
      ON ra.original_consumption_allocation_id = ca.id AND ra.tenant_id = ca.tenant_id
   WHERE ca.tenant_id = p_tenant
     AND sm.order_id = p_order
     AND sm.movement_type = 'sale_deduction';

  IF v_total_cost < 0 THEN
    RAISE EXCEPTION 'order COGS net WIP cost cannot be negative' USING ERRCODE = '23514';
  END IF;
  IF v_total_cost = 0 THEN
    RETURN;
  END IF;

  SELECT debit_ids[1], credit_ids[1], cardinality(debit_ids), cardinality(credit_ids)
    INTO v_debit, v_credit, v_debit_count, v_credit_count
    FROM (
      SELECT
        array_agg(id ORDER BY id) FILTER (WHERE system_purpose = 'cost_of_goods_sold') AS debit_ids,
        array_agg(id ORDER BY id) FILTER (WHERE system_purpose = 'cost_of_goods_in_process') AS credit_ids
      FROM accounts
      WHERE tenant_id = p_tenant AND is_active
        AND system_purpose IN ('cost_of_goods_sold', 'cost_of_goods_in_process')
    ) selected_accounts;
  IF v_debit_count <> 1 OR v_credit_count <> 1 THEN
    RAISE EXCEPTION 'order COGS accounts are missing or ambiguous' USING ERRCODE = '23514';
  END IF;

  INSERT INTO journal_entries
    (tenant_id, branch_id, accounting_date, occurred_at, source_type, source_id,
     currency_code, description, posted_by, posted_at)
  VALUES
    (p_tenant, v_branch, (p_occurred_at AT TIME ZONE v_timezone)::date,
     p_occurred_at, 'order_cogs', p_order, v_currency,
     'Order COGS ' || p_order::text, p_posted_by, p_occurred_at)
  ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING
  RETURNING id INTO v_entry;

  IF v_entry IS NOT NULL THEN
    INSERT INTO journal_entry_lines
      (tenant_id, journal_entry_id, line_number, account_id,
       debit_minor, credit_minor, description)
    VALUES
      (p_tenant, v_entry, 1, v_debit, v_total_cost, 0, 'Cost of goods sold'),
      (p_tenant, v_entry, 2, v_credit, 0, v_total_cost, 'Cost of goods in process');
  ELSIF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE tenant_id = p_tenant AND source_type = 'order_cogs' AND source_id = p_order
  ) THEN
    RAISE EXCEPTION 'order COGS journal could not be posted' USING ERRCODE = '23514';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION post_order_cogs(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
