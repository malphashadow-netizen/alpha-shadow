-- Migration 0022 — Phase 7 (5/10): order items.
--
-- An order item is a PERMANENT SNAPSHOT: the item name, unit price and
-- modifiers are captured at order time and are immutable afterwards (menu
-- changes never rewrite purchase evidence).
--
-- Tax integration: order_items.id IS order_line_tax_contexts.order_line_id
-- (Phase 6, migration 0017). The tax engine writes the context + snapshots in
-- the SAME transaction with the line id the order writer supplies — that is
-- the documented Phase-6 seam (PostgresOrderTaxUnitOfWork passes the existing
-- transaction, never a pool). No redundant FK column can express this before
-- the context row exists, so the linkage is enforced by the creation engine
-- (it only commits when both rows exist) and by reading evidence through the
-- tax snapshot reader.
--
-- INVARIANTS (both enforced at the database level):
--   * station_id is resolved ONCE at creation from an explicit routing rule
--     (migration 0020) and is IMMUTABLE — there is no re-routing path.
--   * current_status_kind_id is derived from order_item_status_events
--     (migration 0023) — the event row is written BEFORE the computed value
--     moves; direct UPDATEs are rejected (app.orders_derived_write guard).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  -- Permanent purchase-evidence snapshot (order-time values, never current
  -- catalog values).
  item_name_snapshot jsonb NOT NULL CHECK (jsonb_typeof(item_name_snapshot) = 'object'),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  modifiers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_status_kind_id uuid NOT NULL,
  -- Resolved by the station-routing engine from an explicit rule. NOT NULL by
  -- design: an item without a station cannot exist (fail-closed).
  station_id uuid NOT NULL,
  -- Void lifecycle: a voided item is excluded from the parent-order status
  -- aggregation and its audit evidence lives in order_voids (migration 0027).
  is_voided boolean NOT NULL DEFAULT false,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_id_tenant_key UNIQUE (id, tenant_id),
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (menu_item_id, tenant_id) REFERENCES menu_items (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (station_id, tenant_id) REFERENCES stations (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_status_kind_id, tenant_id)
    REFERENCES tenant_order_workflow_states (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant_id ON order_items (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_station ON order_items (tenant_id, station_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_items;
CREATE POLICY tenant_isolation ON order_items
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Purchase evidence + routing are immutable. The ONLY mutable columns are the
-- void lifecycle (is_voided/voided_at, written by the void engine) and the
-- derived status (exclusively through the event trigger, which sets
-- app.orders_derived_write around its UPDATE).
CREATE FUNCTION guard_order_item_writes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.station_id IS DISTINCT FROM OLD.station_id THEN
      RAISE EXCEPTION 'order_items.station_id is resolved once at creation by an explicit routing rule and is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.menu_item_id IS DISTINCT FROM OLD.menu_item_id
       OR NEW.item_name_snapshot IS DISTINCT FROM OLD.item_name_snapshot
       OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.modifiers_snapshot IS DISTINCT FROM OLD.modifiers_snapshot
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'order item purchase evidence (name/price/quantity/modifiers) is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.current_status_kind_id IS DISTINCT FROM OLD.current_status_kind_id
       AND NULLIF(current_setting('app.orders_derived_write', true), '') IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'order_items.current_status_kind_id is derived from order_item_status_events; direct writes are forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_order_item_writes ON order_items;
CREATE TRIGGER trg_guard_order_item_writes BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_item_writes();

-- An item starts at an ENABLED state of its own tenant's workflow.
CREATE FUNCTION validate_order_item_status_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_order_workflow_states s
    WHERE s.id = NEW.current_status_kind_id AND s.tenant_id = NEW.tenant_id AND s.is_enabled) THEN
    RAISE EXCEPTION 'order item status must reference an enabled workflow state of the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_item_status_ref ON order_items;
CREATE TRIGGER trg_validate_order_item_status_ref BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION validate_order_item_status_ref();

REVOKE ALL ON order_items FROM PUBLIC;
