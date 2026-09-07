-- Migration 0023 — Phase 7 (6/10): order item status events (source of truth).
--
-- APPEND-ONLY, IMMUTABLE ledger of EVERY item status transition. This table —
-- not order_items.current_status_kind_id — is the truth: the computed value on
-- order_items is derived from the newest event row by the trigger below, and
-- the parent order status is derived from the aggregation of the item
-- statuses (recompute_order_status).
--
-- Ordering invariant (spec: "a status change = an event row BEFORE any update
-- of the computed value"): the BEFORE INSERT validation below requires
-- from_status_kind_id to equal the item's CURRENT status, so an event can
-- never be written against a stale view, and the AFTER INSERT trigger is the
-- only writer of the computed column.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS order_item_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_item_id uuid NOT NULL,
  order_id uuid NOT NULL,
  -- NULL only for the initial event (from nothing → initial state).
  from_status_kind_id uuid,
  to_status_kind_id uuid NOT NULL,
  -- NULL = an automation/system actor.
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_item_id, tenant_id) REFERENCES order_items (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_status_kind_id, tenant_id)
    REFERENCES tenant_order_workflow_states (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_status_kind_id, tenant_id)
    REFERENCES tenant_order_workflow_states (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_order_item_status_events_tenant_id ON order_item_status_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_item_status_events_item ON order_item_status_events (tenant_id, order_item_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_order_item_status_events_order ON order_item_status_events (tenant_id, order_id);

ALTER TABLE order_item_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_status_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_item_status_events;
CREATE POLICY tenant_isolation ON order_item_status_events
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Same immutability pattern as prevent_tax_evidence_mutation (0016) /
-- order_line_tax_snapshots (0017): no UPDATE, no DELETE, ever.
CREATE FUNCTION prevent_order_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55006';
END;
$$;
DROP TRIGGER IF EXISTS trg_order_item_status_events_immutable ON order_item_status_events;
CREATE TRIGGER trg_order_item_status_events_immutable BEFORE UPDATE OR DELETE ON order_item_status_events
  FOR EACH ROW EXECUTE FUNCTION prevent_order_evidence_mutation();

-- Structural integrity of the ledger (fail-closed on every dimension):
--   * the item belongs to the same tenant and the event's order_id matches;
--   * from_status_kind_id equals the item's CURRENT status (event-before-
--     computed-update ordering);
--   * the target is an ENABLED state of the same tenant (a disabled state is
--     not part of the tenant's effective sequence — transitions into it are
--     rejected at the database level too);
--   * a recorded actor is an ACTIVE user of the same tenant.
CREATE FUNCTION validate_order_item_status_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_current uuid; v_order uuid;
BEGIN
  SELECT current_status_kind_id, order_id INTO v_current, v_order
    FROM public.order_items WHERE id = NEW.order_item_id AND tenant_id = NEW.tenant_id;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'status event must reference an order item of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF v_order <> NEW.order_id THEN
    RAISE EXCEPTION 'status event order_id must match the item''s order' USING ERRCODE = '23514';
  END IF;
  IF NEW.from_status_kind_id IS NOT NULL AND NEW.from_status_kind_id <> v_current THEN
    RAISE EXCEPTION 'from_status_kind_id must equal the item''s current status: the event row is written before any derived update' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_order_workflow_states s
    WHERE s.id = NEW.to_status_kind_id AND s.tenant_id = NEW.tenant_id AND s.is_enabled) THEN
    RAISE EXCEPTION 'status events may only transition into an enabled workflow state of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW.actor_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'status event actor must be an active user of the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_item_status_event ON order_item_status_events;
CREATE TRIGGER trg_validate_order_item_status_event BEFORE INSERT ON order_item_status_events
  FOR EACH ROW EXECUTE FUNCTION validate_order_item_status_event();

-- The ONLY writer of the computed item status, followed by the parent-order
-- recompute. (Migration 0024 replaces the FUNCTION BODIES — same signatures —
-- so both also append outbox rows in the same transaction; the triggers keep
-- pointing at the same functions.)
CREATE FUNCTION apply_order_item_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.orders_derived_write', '1', true);
  UPDATE public.order_items SET current_status_kind_id = NEW.to_status_kind_id
    WHERE id = NEW.order_item_id AND tenant_id = NEW.tenant_id;
  PERFORM set_config('app.orders_derived_write', '', true);
  PERFORM recompute_order_status(NEW.tenant_id, NEW.order_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_apply_order_item_status ON order_item_status_events;
CREATE TRIGGER trg_apply_order_item_status AFTER INSERT ON order_item_status_events
  FOR EACH ROW EXECUTE FUNCTION apply_order_item_status();

-- Parent-order status = the EARLIEST (lowest-position top-level) state among
-- the active (non-voided) items' root kinds: the order is "ready" only when
-- EVERY item is ready; one item in "preparing – waiting for ingredient" keeps
-- the whole order "preparing". Sub-state → its parent kind. A terminal target
-- closes the order (closed_at) exactly once.
CREATE FUNCTION recompute_order_status(p_tenant uuid, p_order uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_current uuid; v_target uuid; v_terminal boolean;
BEGIN
  SELECT o.current_status_kind_id INTO v_current FROM public.orders o
    WHERE o.id = p_order AND o.tenant_id = p_tenant;
  IF v_current IS NULL THEN RETURN NULL; END IF;
  SELECT ts.id, (k.behavior_flags ->> 'is_terminal')::boolean INTO v_target, v_terminal
  FROM (
    SELECT DISTINCT COALESCE(s.parent_kind_code, s.kind_code) AS root_kind
    FROM public.order_items i
    JOIN public.tenant_order_workflow_states s ON s.id = i.current_status_kind_id AND s.tenant_id = i.tenant_id
    WHERE i.order_id = p_order AND i.tenant_id = p_tenant AND NOT i.is_voided
  ) roots
  JOIN public.tenant_order_workflow_states ts
    ON ts.tenant_id = p_tenant AND ts.parent_kind_code IS NULL AND ts.kind_code = roots.root_kind
  JOIN public.order_status_kinds k ON k.code = ts.kind_code
  ORDER BY ts.position ASC
  LIMIT 1;
  IF v_target IS NULL OR v_target = v_current THEN RETURN v_current; END IF;
  PERFORM set_config('app.orders_derived_write', '1', true);
  UPDATE public.orders SET current_status_kind_id = v_target,
    closed_at = CASE WHEN v_terminal AND closed_at IS NULL THEN now() ELSE closed_at END
    WHERE id = p_order AND tenant_id = p_tenant;
  PERFORM set_config('app.orders_derived_write', '', true);
  RETURN v_target;
END;
$$;

REVOKE ALL ON order_item_status_events FROM PUBLIC;
