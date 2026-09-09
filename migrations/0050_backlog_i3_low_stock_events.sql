-- Migration 0050 — Backlog (I3): low-stock crossing events + branch mutes.
--
-- WHAT: when a movement drives a component's balance from AT-or-ABOVE its
-- low_stock_threshold to BELOW it, exactly one 'inventory.low_stock' event is
-- appended to a dedicated inventory outbox (KDS-pattern, 0024 mirror). A
-- separate presence table lets branch leadership MUTE a branch's alerts.
--
-- WHY A SEPARATE OUTBOX: order_events_outbox feeds the KDS stream with a
-- gapless per-branch ORDER sequence. Inventory alerts are a different stream
-- with different consumers; mixing them would pollute KDS ordering and the
-- claim-then-execute delivery ledger. Same shape, separate tables.
--
-- EDGE SEMANTICS (documented, pinned by phase9 live tests):
--   * The trigger fires on UPDATE OF current_quantity only, when
--     OLD >= threshold AND NEW < threshold (threshold must be SET; NULL
--     means the component opted out and NEVER emits).
--   * Deeper drains while already below emit NOTHING (edge, not level).
--   * Re-arm requires recovery: the balance must climb back to >= threshold
--     before the next crossing emits again.
--   * Raising the threshold ABOVE a sitting balance does NOT emit by itself
--     (threshold edits are config, not crossings); the item simply shows in
--     the live alerts view until restocked above the line.
--   * ALL movement paths funnel through apply_stock_movement, so every
--     crossing — sale, adjustment, even forged-direct-SQL — emits exactly
--     once. Direct quantity writes stay forbidden by the guard trigger.
--
-- MUTE PHILOSOPHY (decided at implementation, per the approved I3 scope):
-- per-BRANCH muting. Low-stock response is branch-operational (reorder the
-- shelf), and hiding shrinkage signals is sensitive — so muting requires the
-- same 'inventory:adjust' key as manual adjustments. The mute controls ONLY
-- the actionable alerts view; the outbox history is NEVER filtered (the
-- historical record stays complete by structure, not by convention).
--
-- NOTE: muting is presence-based (row EXISTS ⇒ muted); unmuting deletes the
-- row. No boolean to drift, no scheduled expiry to forget.
--
-- DEPENDS ON: 0037 (inventory_items.current_quantity + low_stock_threshold),
-- 0024 (pattern reference only).

-- ── (1) per-branch gapless sequences (0024 mirror) ─────────────────────────
CREATE TABLE IF NOT EXISTS inventory_event_sequences (
  branch_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_inventory_event_sequences_tenant_id ON inventory_event_sequences (tenant_id);

ALTER TABLE inventory_event_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_event_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_event_sequences;
CREATE POLICY tenant_isolation ON inventory_event_sequences
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE OR REPLACE FUNCTION next_inventory_event_sequence(p_branch uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_seq bigint;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.branches WHERE id = p_branch;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'branch % not found for inventory outbox sequencing', p_branch USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.inventory_event_sequences (branch_id, tenant_id, last_sequence)
    VALUES (p_branch, v_tenant, 0)
  ON CONFLICT (branch_id) DO NOTHING;
  UPDATE public.inventory_event_sequences SET last_sequence = last_sequence + 1
    WHERE branch_id = p_branch
    RETURNING last_sequence INTO v_seq;
  RETURN v_seq;
END;
$$;

-- ── (2) inventory events outbox (0024 mirror) ──────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_events_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  -- Gapless, strictly increasing PER BRANCH. The UNIQUE constraint makes a
  -- duplicate number structurally impossible.
  sequence_id bigint NOT NULL CHECK (sequence_id > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_events_outbox_branch_sequence UNIQUE (branch_id, sequence_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_events_outbox_branch_sequence ON inventory_events_outbox (branch_id, sequence_id);
CREATE INDEX IF NOT EXISTS idx_inventory_events_outbox_tenant_id ON inventory_events_outbox (tenant_id);

ALTER TABLE inventory_events_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_events_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_events_outbox;
CREATE POLICY tenant_isolation ON inventory_events_outbox
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE OR REPLACE FUNCTION append_inventory_event(p_tenant uuid, p_branch uuid, p_event_type text, p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_seq bigint;
BEGIN
  v_seq := public.next_inventory_event_sequence(p_branch);
  INSERT INTO public.inventory_events_outbox (tenant_id, branch_id, sequence_id, event_type, payload)
    VALUES (p_tenant, p_branch, v_seq, p_event_type, COALESCE(p_payload, '{}'::jsonb));
  RETURN v_seq;
END;
$$;

-- ── (3) the edge trigger: crossing below the threshold emits once ──────────
CREATE OR REPLACE FUNCTION emit_low_stock_crossing() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.low_stock_threshold IS NOT NULL
     AND OLD.current_quantity >= OLD.low_stock_threshold
     AND NEW.current_quantity < OLD.low_stock_threshold THEN
    PERFORM public.append_inventory_event(
      NEW.tenant_id,
      NEW.branch_id,
      'inventory.low_stock',
      jsonb_build_object(
        'inventory_item_id', NEW.id,
        'branch_id', NEW.branch_id,
        'low_stock_threshold', OLD.low_stock_threshold::text,
        'balance_before', OLD.current_quantity::text,
        'balance_after', NEW.current_quantity::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emit_low_stock_crossing ON inventory_items;
CREATE TRIGGER trg_emit_low_stock_crossing
  AFTER UPDATE OF current_quantity ON inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION emit_low_stock_crossing();

-- ── (4) branch mutes (presence = muted) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS low_stock_mutes (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  muted_by uuid NOT NULL REFERENCES users (id),
  muted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_low_stock_mutes_branch_id ON low_stock_mutes (branch_id);

ALTER TABLE low_stock_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE low_stock_mutes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON low_stock_mutes;
CREATE POLICY tenant_isolation ON low_stock_mutes
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

REVOKE ALL ON inventory_event_sequences, inventory_events_outbox, low_stock_mutes FROM PUBLIC;
