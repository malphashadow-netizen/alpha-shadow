CREATE OR REPLACE FUNCTION settle_zero_basis_adjustments() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a record; units bigint; settled bigint; entry uuid; variance uuid; asset uuid;
BEGIN
  IF NEW.is_provisional THEN RETURN NEW; END IF;
  units := (NEW.original_qty * 10000)::bigint;
  IF units = 0 THEN RETURN NEW; END IF;
  FOR a IN SELECT aca.id, aca.qty, sm.branch_id, sm.id movement_id FROM public.adjustment_cost_allocations aca
    JOIN public.stock_movements sm ON sm.id=aca.stock_movement_id AND sm.tenant_id=aca.tenant_id
    WHERE aca.tenant_id=NEW.tenant_id AND aca.layer_id IS NULL AND aca.is_provisional
  LOOP
    settled := (NEW.total_cost_minor * (a.qty*10000)::bigint) / units;
    INSERT INTO public.inventory_provisional_cost_settlements (tenant_id,adjustment_cost_allocation_id,settled_cost_minor)
      VALUES (NEW.tenant_id,a.id,settled) ON CONFLICT (adjustment_cost_allocation_id) DO NOTHING RETURNING id INTO entry;
    IF entry IS NOT NULL AND settled > 0 THEN
      SELECT min(id::text)::uuid INTO variance FROM public.accounts WHERE tenant_id=NEW.tenant_id AND is_active AND system_purpose='inventory_variance';
      SELECT min(id::text)::uuid INTO asset FROM public.accounts WHERE tenant_id=NEW.tenant_id AND is_active AND system_purpose='inventory_asset';
      INSERT INTO public.journal_entries (tenant_id,branch_id,accounting_date,occurred_at,source_type,source_id,currency_code,description,posted_by,posted_at)
        SELECT NEW.tenant_id,a.branch_id,(now() AT TIME ZONE b.timezone)::date,now(),'inventory_provisional_settlement',entry,b.base_currency,'Inventory provisional settlement '||entry,sm.actor_user_id,now()
        FROM public.branches b JOIN public.stock_movements sm ON sm.tenant_id=NEW.tenant_id AND sm.id=a.movement_id WHERE b.tenant_id=NEW.tenant_id AND b.id=a.branch_id;
      INSERT INTO public.journal_entry_lines (tenant_id,journal_entry_id,line_number,account_id,debit_minor,credit_minor,description)
        SELECT NEW.tenant_id,j.id,1,variance,settled,0,'Inventory variance' FROM public.journal_entries j WHERE j.tenant_id=NEW.tenant_id AND j.source_type='inventory_provisional_settlement' AND j.source_id=entry;
      INSERT INTO public.journal_entry_lines (tenant_id,journal_entry_id,line_number,account_id,debit_minor,credit_minor,description)
        SELECT NEW.tenant_id,j.id,2,asset,0,settled,'Inventory asset' FROM public.journal_entries j WHERE j.tenant_id=NEW.tenant_id AND j.source_type='inventory_provisional_settlement' AND j.source_id=entry;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
