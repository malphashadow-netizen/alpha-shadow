-- DD-005 phase 8: controlled negative adjustments and non-chaining provisional cost.
-- The settlement evidence table references an allocation through the tenant
-- composite key, matching the repository-wide tenant-scoped FK convention.
ALTER TABLE adjustment_cost_allocations
  ADD CONSTRAINT adjustment_cost_allocations_id_tenant_key UNIQUE (id, tenant_id);

ALTER TABLE manager_override_attempts DROP CONSTRAINT IF EXISTS manager_override_attempts_context_type_check;
ALTER TABLE manager_override_attempts ADD CONSTRAINT manager_override_attempts_context_type_check
  CHECK (context_type IN ('void', 'discount', 'stock_override', 'manual_adjustment'));

CREATE FUNCTION validate_negative_manual_adjustment_override() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.movement_type = 'manual_adjustment' AND NEW.quantity_delta < 0 AND NOT EXISTS (
    SELECT 1 FROM manager_override_attempts a WHERE a.id = NEW.manager_override_id AND a.tenant_id = NEW.tenant_id
      AND a.outcome = 'succeeded' AND a.context_type = 'manual_adjustment'
      AND a.initiating_actor_user_id = NEW.actor_user_id
  ) THEN
    RAISE EXCEPTION 'negative manual_adjustment without a manager override' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION settle_zero_basis_adjustments() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a record; units bigint; settled bigint; entry uuid; variance uuid; asset uuid;
BEGIN
  IF NEW.is_provisional THEN RETURN NEW; END IF;
  units := (NEW.original_qty * 10000)::bigint;
  IF units = 0 THEN RETURN NEW; END IF;
  FOR a IN SELECT aca.id, aca.qty, sm.branch_id, sm.id movement_id FROM adjustment_cost_allocations aca
    JOIN stock_movements sm ON sm.id=aca.stock_movement_id AND sm.tenant_id=aca.tenant_id
    WHERE aca.tenant_id=NEW.tenant_id AND aca.layer_id IS NULL AND aca.is_provisional
  LOOP
    settled := (NEW.total_cost_minor * (a.qty*10000)::bigint) / units;
    INSERT INTO inventory_provisional_cost_settlements (tenant_id,adjustment_cost_allocation_id,settled_cost_minor)
      VALUES (NEW.tenant_id,a.id,settled) ON CONFLICT (adjustment_cost_allocation_id) DO NOTHING RETURNING id INTO entry;
    IF entry IS NOT NULL AND settled > 0 THEN
      SELECT min(id::text)::uuid INTO variance FROM accounts WHERE tenant_id=NEW.tenant_id AND is_active AND system_purpose='inventory_variance';
      SELECT min(id::text)::uuid INTO asset FROM accounts WHERE tenant_id=NEW.tenant_id AND is_active AND system_purpose='inventory_asset';
      INSERT INTO journal_entries (tenant_id,branch_id,accounting_date,occurred_at,source_type,source_id,currency_code,description,posted_by,posted_at)
        SELECT NEW.tenant_id,a.branch_id,(now() AT TIME ZONE b.timezone)::date,now(),'inventory_provisional_settlement',entry,b.base_currency,'Inventory provisional settlement '||entry,sm.actor_user_id,now()
        FROM branches b JOIN stock_movements sm ON sm.tenant_id=NEW.tenant_id AND sm.id=a.movement_id WHERE b.tenant_id=NEW.tenant_id AND b.id=a.branch_id;
      INSERT INTO journal_entry_lines (tenant_id,journal_entry_id,line_number,account_id,debit_minor,credit_minor,description)
        SELECT NEW.tenant_id,j.id,1,variance,settled,0,'Inventory variance' FROM journal_entries j WHERE j.tenant_id=NEW.tenant_id AND j.source_type='inventory_provisional_settlement' AND j.source_id=entry;
      INSERT INTO journal_entry_lines (tenant_id,journal_entry_id,line_number,account_id,debit_minor,credit_minor,description)
        SELECT NEW.tenant_id,j.id,2,asset,0,settled,'Inventory asset' FROM journal_entries j WHERE j.tenant_id=NEW.tenant_id AND j.source_type='inventory_provisional_settlement' AND j.source_id=entry;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_settle_zero_basis_adjustments AFTER INSERT ON inventory_cost_layers
  FOR EACH ROW EXECUTE FUNCTION settle_zero_basis_adjustments();
CREATE TRIGGER trg_negative_manual_adjustment_override AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION validate_negative_manual_adjustment_override();

CREATE TABLE inventory_provisional_cost_settlements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants (id),
  adjustment_cost_allocation_id bigint NOT NULL UNIQUE, settled_cost_minor bigint NOT NULL CHECK (settled_cost_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (adjustment_cost_allocation_id, tenant_id) REFERENCES adjustment_cost_allocations (id, tenant_id)
);
ALTER TABLE inventory_provisional_cost_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_provisional_cost_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_provisional_cost_settlements FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION post_inventory_adjustment(p_tenant uuid, p_movement uuid, p_posted_by uuid, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE m record; l record; needed bigint; take bigint; units bigint; cost bigint; total bigint := 0; basis record; ledger bigint; layer bigint;
BEGIN
 SELECT sm.*, r.adjustment_reason_kind_code kind_code INTO m FROM stock_movements sm LEFT JOIN tenant_adjustment_reasons r ON r.tenant_id=sm.tenant_id AND r.id=sm.adjustment_reason_id WHERE sm.tenant_id=p_tenant AND sm.id=p_movement;
 IF NOT FOUND OR m.movement_type <> 'manual_adjustment' THEN RAISE EXCEPTION 'manual inventory adjustment movement was not found' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM adjustment_cost_allocations WHERE tenant_id=p_tenant AND stock_movement_id=p_movement) THEN RETURN; END IF;
 IF m.quantity_delta >= 0 THEN RETURN; END IF;
 needed := (abs(m.quantity_delta)*10000)::bigint;
 FOR l IN SELECT * FROM inventory_cost_layers WHERE tenant_id=p_tenant AND inventory_item_id=m.inventory_item_id AND remaining_qty>0 ORDER BY is_provisional, created_at, id FOR UPDATE LOOP
   EXIT WHEN needed=0; units := (l.remaining_qty*10000)::bigint; take := least(needed,units);
   cost := CASE WHEN take=units THEN l.remaining_cost_minor ELSE (l.remaining_cost_minor*take)/units END;
   INSERT INTO adjustment_cost_allocations (tenant_id,stock_movement_id,layer_id,qty,allocated_cost_minor,is_provisional) VALUES (p_tenant,p_movement,l.id,take::numeric/10000,cost,l.is_provisional);
   UPDATE inventory_cost_layers SET remaining_qty=remaining_qty-take::numeric/10000,remaining_cost_minor=remaining_cost_minor-cost WHERE id=l.id;
   total:=total+cost; needed:=needed-take;
 END LOOP;
 IF needed>0 THEN
   SELECT cl.total_cost_minor,(cl.original_qty*10000)::bigint units,cl.currency_code,cl.minor_unit_digits INTO basis
   FROM inventory_cost_ledger cl JOIN stock_movements sm ON sm.tenant_id=cl.tenant_id AND sm.id=cl.stock_movement_id
   WHERE cl.tenant_id=p_tenant AND cl.inventory_item_id=m.inventory_item_id AND NOT cl.is_provisional AND sm.movement_type='manual_receiving'
   ORDER BY sm.created_at DESC,sm.id DESC LIMIT 1;
   IF basis.units IS NULL THEN
     INSERT INTO adjustment_cost_allocations (tenant_id,stock_movement_id,layer_id,qty,allocated_cost_minor,is_provisional) VALUES (p_tenant,p_movement,NULL,needed::numeric/10000,0,true);
   ELSE
     cost := (basis.total_cost_minor*needed)/basis.units;
     INSERT INTO inventory_cost_ledger (tenant_id,inventory_item_id,stock_movement_id,total_cost_minor,original_qty,currency_code,minor_unit_digits,is_provisional) VALUES (p_tenant,m.inventory_item_id,p_movement,cost,needed::numeric/10000,basis.currency_code,basis.minor_unit_digits,true) RETURNING id INTO ledger;
     INSERT INTO inventory_cost_layers (tenant_id,inventory_item_id,cost_ledger_id,original_qty,remaining_qty,total_cost_minor,remaining_cost_minor,currency_code,minor_unit_digits,is_provisional) VALUES (p_tenant,m.inventory_item_id,ledger,needed::numeric/10000,0,cost,0,basis.currency_code,basis.minor_unit_digits,true) RETURNING id INTO layer;
     INSERT INTO adjustment_cost_allocations (tenant_id,stock_movement_id,layer_id,qty,allocated_cost_minor,is_provisional) VALUES (p_tenant,p_movement,layer,needed::numeric/10000,cost,true); total:=total+cost;
   END IF;
 END IF;
 -- Existing phase-5 accounting remains authoritative for non-zero adjustments.
END;
$$;
