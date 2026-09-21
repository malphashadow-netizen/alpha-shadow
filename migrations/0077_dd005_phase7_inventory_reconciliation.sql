-- DD-005 phase 7: report-only inventory reconciliation and frozen monthly
-- checkpoints. Reconciliation never repairs inventory projections.

CREATE TABLE inventory_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  quantity_discrepancy_count bigint NOT NULL CHECK (quantity_discrepancy_count >= 0),
  layer_discrepancy_count bigint NOT NULL CHECK (layer_discrepancy_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reconciliation_runs_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT inventory_reconciliation_runs_time_order
    CHECK (completed_at >= started_at)
);

CREATE INDEX idx_inventory_reconciliation_runs_tenant_cutoff
  ON inventory_reconciliation_runs (tenant_id, cutoff_at DESC);

CREATE TABLE inventory_reconciliation_findings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  run_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  cost_ledger_id bigint,
  layer_id bigint,
  discrepancy_type text NOT NULL CHECK (discrepancy_type IN (
    'current_quantity_mismatch',
    'missing_layer',
    'orphan_layer',
    'layer_identity_mismatch',
    'quantity_mismatch',
    'cost_mismatch',
    'quantity_and_cost_mismatch'
  )),
  projected_quantity numeric(18,4),
  rebuilt_quantity numeric(18,4),
  projected_remaining_qty numeric(18,4),
  rebuilt_remaining_qty numeric(18,4),
  projected_remaining_cost_minor bigint,
  rebuilt_remaining_cost_minor bigint,
  currency_code text REFERENCES currencies (code),
  minor_unit_digits smallint CHECK (minor_unit_digits BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reconciliation_findings_run_fk
    FOREIGN KEY (run_id, tenant_id)
    REFERENCES inventory_reconciliation_runs (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_inventory_reconciliation_findings_run
  ON inventory_reconciliation_findings (tenant_id, run_id, id);
CREATE INDEX idx_inventory_reconciliation_findings_item
  ON inventory_reconciliation_findings (tenant_id, inventory_item_id, id);

CREATE TABLE inventory_reconciliation_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  period_end timestamptz NOT NULL,
  source_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_reconciliation_months_tenant_period_key
    UNIQUE (tenant_id, period_end),
  CONSTRAINT inventory_reconciliation_months_id_tenant_key
    UNIQUE (id, tenant_id),
  CONSTRAINT inventory_reconciliation_months_run_fk
    FOREIGN KEY (source_run_id, tenant_id)
    REFERENCES inventory_reconciliation_runs (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE inventory_reconciliation_item_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  month_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  rebuilt_quantity numeric(18,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month_id, inventory_item_id),
  FOREIGN KEY (month_id, tenant_id)
    REFERENCES inventory_reconciliation_months (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE inventory_reconciliation_layer_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  month_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  cost_ledger_id bigint NOT NULL,
  layer_id bigint NOT NULL,
  rebuilt_remaining_qty numeric(18,4) NOT NULL,
  rebuilt_remaining_cost_minor bigint NOT NULL,
  currency_code text NOT NULL REFERENCES currencies (code),
  minor_unit_digits smallint NOT NULL CHECK (minor_unit_digits BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month_id, layer_id),
  FOREIGN KEY (month_id, tenant_id)
    REFERENCES inventory_reconciliation_months (id, tenant_id)
    ON DELETE RESTRICT
);

ALTER TABLE inventory_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_findings FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_months FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_item_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_item_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_layer_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reconciliation_layer_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inventory_reconciliation_runs FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON inventory_reconciliation_findings FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON inventory_reconciliation_months FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON inventory_reconciliation_item_snapshots FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON inventory_reconciliation_layer_snapshots FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE FUNCTION prevent_inventory_reconciliation_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'inventory reconciliation evidence is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER trg_inventory_reconciliation_runs_immutable
  BEFORE UPDATE OR DELETE ON inventory_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_reconciliation_mutation();
CREATE TRIGGER trg_inventory_reconciliation_findings_immutable
  BEFORE UPDATE OR DELETE ON inventory_reconciliation_findings
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_reconciliation_mutation();
CREATE TRIGGER trg_inventory_reconciliation_months_immutable
  BEFORE UPDATE OR DELETE ON inventory_reconciliation_months
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_reconciliation_mutation();
CREATE TRIGGER trg_inventory_reconciliation_item_snapshots_immutable
  BEFORE UPDATE OR DELETE ON inventory_reconciliation_item_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_reconciliation_mutation();
CREATE TRIGGER trg_inventory_reconciliation_layer_snapshots_immutable
  BEFORE UPDATE OR DELETE ON inventory_reconciliation_layer_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_reconciliation_mutation();

CREATE FUNCTION reconcile_inventory(p_tenant uuid)
RETURNS TABLE (
  discrepancy_type text,
  inventory_item_id uuid,
  cost_ledger_id bigint,
  layer_id bigint,
  projected_quantity numeric(18,4),
  rebuilt_quantity numeric(18,4),
  projected_remaining_qty numeric(18,4),
  rebuilt_remaining_qty numeric(18,4),
  projected_remaining_cost_minor bigint,
  rebuilt_remaining_cost_minor bigint,
  currency_code text,
  minor_unit_digits smallint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'inventory reconciliation tenant must match current tenant' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH rebuilt_item_quantities AS (
    SELECT sm.tenant_id, sm.inventory_item_id,
           COALESCE(sum(sm.quantity_delta), 0::numeric)::numeric(18,4) AS rebuilt_quantity
      FROM public.stock_movements AS sm
     WHERE sm.tenant_id = p_tenant
     GROUP BY sm.tenant_id, sm.inventory_item_id
  ),
  quantity_findings AS (
    SELECT 'current_quantity_mismatch'::text AS discrepancy_type,
           item.id AS inventory_item_id,
           NULL::bigint AS cost_ledger_id,
           NULL::bigint AS layer_id,
           item.current_quantity AS projected_quantity,
           COALESCE(rebuilt.rebuilt_quantity, 0::numeric)::numeric(18,4) AS rebuilt_quantity,
           NULL::numeric(18,4) AS projected_remaining_qty,
           NULL::numeric(18,4) AS rebuilt_remaining_qty,
           NULL::bigint AS projected_remaining_cost_minor,
           NULL::bigint AS rebuilt_remaining_cost_minor,
           NULL::text AS currency_code,
           NULL::smallint AS minor_unit_digits
      FROM public.inventory_items AS item
      LEFT JOIN rebuilt_item_quantities AS rebuilt
        ON rebuilt.tenant_id = item.tenant_id
       AND rebuilt.inventory_item_id = item.id
     WHERE item.tenant_id = p_tenant
       AND item.current_quantity IS DISTINCT FROM COALESCE(rebuilt.rebuilt_quantity, 0::numeric)
  ),
  projected_layers AS (
    SELECT layer.id, layer.tenant_id, layer.inventory_item_id, layer.cost_ledger_id,
           layer.original_qty, layer.remaining_qty, layer.total_cost_minor,
           layer.remaining_cost_minor, layer.currency_code, layer.minor_unit_digits,
           layer.is_provisional
      FROM public.inventory_cost_layers AS layer
     WHERE layer.tenant_id = p_tenant
  ),
  consumed AS (
    SELECT allocation.tenant_id, allocation.layer_id,
           sum(allocation.qty)::numeric(18,4) AS consumed_qty,
           sum(allocation.allocated_cost_minor)::bigint AS consumed_cost_minor
      FROM public.consumption_allocations AS allocation
     WHERE allocation.tenant_id = p_tenant
       AND allocation.layer_id IS NOT NULL
     GROUP BY allocation.tenant_id, allocation.layer_id
  ),
  restored AS (
    SELECT restoration.tenant_id, restoration.layer_id,
           (-sum(restoration.qty) FILTER (
             WHERE restoration.disposition NOT IN ('waste_void', 'waste_refund')
           ))::numeric(18,4) AS restored_qty,
           (sum(restoration.restored_cost_minor) FILTER (
             WHERE restoration.disposition NOT IN ('waste_void', 'waste_refund')
           ))::bigint AS restored_cost_minor
      FROM public.restoration_allocations AS restoration
     WHERE restoration.tenant_id = p_tenant
       AND restoration.layer_id IS NOT NULL
     GROUP BY restoration.tenant_id, restoration.layer_id
  ),
  rebuilt_layers AS (
    SELECT ledger.tenant_id, ledger.id AS cost_ledger_id, ledger.inventory_item_id,
           ledger.original_qty, ledger.total_cost_minor, ledger.currency_code,
           ledger.minor_unit_digits, ledger.is_provisional,
           (ledger.original_qty - COALESCE(consumed.consumed_qty, 0::numeric)
             + COALESCE(restored.restored_qty, 0::numeric))::numeric(18,4) AS remaining_qty,
           (ledger.total_cost_minor - COALESCE(consumed.consumed_cost_minor, 0::bigint)
             + COALESCE(restored.restored_cost_minor, 0::bigint))::bigint AS remaining_cost_minor
      FROM public.inventory_cost_ledger AS ledger
      LEFT JOIN projected_layers AS layer
        ON layer.tenant_id = ledger.tenant_id
       AND layer.cost_ledger_id = ledger.id
      LEFT JOIN consumed
        ON consumed.tenant_id = layer.tenant_id
       AND consumed.layer_id = layer.id
      LEFT JOIN restored
        ON restored.tenant_id = layer.tenant_id
       AND restored.layer_id = layer.id
     WHERE ledger.tenant_id = p_tenant
  ),
  layer_findings AS (
    SELECT CASE
             WHEN layer.id IS NULL THEN 'missing_layer'
             WHEN layer.inventory_item_id IS DISTINCT FROM rebuilt.inventory_item_id
               OR layer.original_qty IS DISTINCT FROM rebuilt.original_qty
               OR layer.total_cost_minor IS DISTINCT FROM rebuilt.total_cost_minor
               OR layer.currency_code IS DISTINCT FROM rebuilt.currency_code
               OR layer.minor_unit_digits IS DISTINCT FROM rebuilt.minor_unit_digits
               OR layer.is_provisional IS DISTINCT FROM rebuilt.is_provisional
               THEN 'layer_identity_mismatch'
             WHEN layer.remaining_qty IS DISTINCT FROM rebuilt.remaining_qty
               AND layer.remaining_cost_minor IS DISTINCT FROM rebuilt.remaining_cost_minor
               THEN 'quantity_and_cost_mismatch'
             WHEN layer.remaining_qty IS DISTINCT FROM rebuilt.remaining_qty THEN 'quantity_mismatch'
             ELSE 'cost_mismatch'
           END::text AS discrepancy_type,
           rebuilt.inventory_item_id, rebuilt.cost_ledger_id, layer.id AS layer_id,
           NULL::numeric(18,4) AS projected_quantity,
           NULL::numeric(18,4) AS rebuilt_quantity,
           layer.remaining_qty AS projected_remaining_qty,
           rebuilt.remaining_qty AS rebuilt_remaining_qty,
           layer.remaining_cost_minor AS projected_remaining_cost_minor,
           rebuilt.remaining_cost_minor AS rebuilt_remaining_cost_minor,
           rebuilt.currency_code, rebuilt.minor_unit_digits
      FROM rebuilt_layers AS rebuilt
      LEFT JOIN projected_layers AS layer
        ON layer.tenant_id = rebuilt.tenant_id
       AND layer.cost_ledger_id = rebuilt.cost_ledger_id
     WHERE layer.id IS NULL
        OR layer.inventory_item_id IS DISTINCT FROM rebuilt.inventory_item_id
        OR layer.original_qty IS DISTINCT FROM rebuilt.original_qty
        OR layer.total_cost_minor IS DISTINCT FROM rebuilt.total_cost_minor
        OR layer.currency_code IS DISTINCT FROM rebuilt.currency_code
        OR layer.minor_unit_digits IS DISTINCT FROM rebuilt.minor_unit_digits
        OR layer.is_provisional IS DISTINCT FROM rebuilt.is_provisional
        OR layer.remaining_qty IS DISTINCT FROM rebuilt.remaining_qty
        OR layer.remaining_cost_minor IS DISTINCT FROM rebuilt.remaining_cost_minor
  ),
  orphan_findings AS (
    SELECT 'orphan_layer'::text AS discrepancy_type,
           layer.inventory_item_id, layer.cost_ledger_id, layer.id AS layer_id,
           NULL::numeric(18,4) AS projected_quantity,
           NULL::numeric(18,4) AS rebuilt_quantity,
           layer.remaining_qty AS projected_remaining_qty,
           NULL::numeric(18,4) AS rebuilt_remaining_qty,
           layer.remaining_cost_minor AS projected_remaining_cost_minor,
           NULL::bigint AS rebuilt_remaining_cost_minor,
           layer.currency_code, layer.minor_unit_digits
      FROM projected_layers AS layer
      LEFT JOIN public.inventory_cost_ledger AS ledger
        ON ledger.tenant_id = layer.tenant_id
       AND ledger.id = layer.cost_ledger_id
     WHERE ledger.id IS NULL
  )
  SELECT * FROM quantity_findings
  UNION ALL SELECT * FROM layer_findings
  UNION ALL SELECT * FROM orphan_findings
  ORDER BY inventory_item_id, cost_ledger_id NULLS FIRST, layer_id NULLS FIRST;
END;
$$;

CREATE FUNCTION record_inventory_reconciliation(
  p_tenant uuid,
  p_started_at timestamptz,
  p_cutoff_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_run_id uuid := gen_random_uuid();
  v_recorded_run_id uuid;
BEGIN
  IF p_tenant IS DISTINCT FROM current_setting('app.current_tenant_id')::uuid THEN
    RAISE EXCEPTION 'inventory reconciliation tenant must match current tenant' USING ERRCODE = '42501';
  END IF;
  IF p_started_at > v_now THEN
    RAISE EXCEPTION 'inventory reconciliation started_at cannot be in the future' USING ERRCODE = '22007';
  END IF;
  IF p_cutoff_at > v_now THEN
    RAISE EXCEPTION 'inventory reconciliation cutoff_at cannot be in the future' USING ERRCODE = '22007';
  END IF;

  WITH report AS MATERIALIZED (
    SELECT * FROM public.reconcile_inventory(p_tenant)
  ),
  summary AS (
    SELECT count(*) FILTER (
             WHERE discrepancy_type = 'current_quantity_mismatch'
           )::bigint AS quantity_discrepancy_count,
           count(*) FILTER (
             WHERE discrepancy_type <> 'current_quantity_mismatch'
           )::bigint AS layer_discrepancy_count
      FROM report
  ),
  inserted_run AS (
    INSERT INTO public.inventory_reconciliation_runs
      (id, tenant_id, started_at, completed_at, cutoff_at, status,
       quantity_discrepancy_count, layer_discrepancy_count)
    SELECT v_run_id, p_tenant, p_started_at, v_now, p_cutoff_at, 'completed',
           summary.quantity_discrepancy_count, summary.layer_discrepancy_count
      FROM summary
    RETURNING id
  ),
  inserted_findings AS (
    INSERT INTO public.inventory_reconciliation_findings
      (tenant_id, run_id, inventory_item_id, cost_ledger_id, layer_id,
       discrepancy_type, projected_quantity, rebuilt_quantity,
       projected_remaining_qty, rebuilt_remaining_qty,
       projected_remaining_cost_minor, rebuilt_remaining_cost_minor,
       currency_code, minor_unit_digits)
    SELECT p_tenant, inserted_run.id, report.inventory_item_id,
           report.cost_ledger_id, report.layer_id, report.discrepancy_type,
           report.projected_quantity, report.rebuilt_quantity,
           report.projected_remaining_qty, report.rebuilt_remaining_qty,
           report.projected_remaining_cost_minor,
           report.rebuilt_remaining_cost_minor, report.currency_code,
           report.minor_unit_digits
      FROM report
      CROSS JOIN inserted_run
    RETURNING id
  )
  SELECT inserted_run.id
    INTO v_recorded_run_id
    FROM inserted_run
    LEFT JOIN (SELECT count(*) FROM inserted_findings) AS completed_write ON true;

  RETURN v_recorded_run_id;
END;
$$;

REVOKE ALL ON inventory_reconciliation_runs,
  inventory_reconciliation_findings,
  inventory_reconciliation_months,
  inventory_reconciliation_item_snapshots,
  inventory_reconciliation_layer_snapshots FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_inventory(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_inventory_reconciliation(uuid, timestamptz, timestamptz) FROM PUBLIC;
