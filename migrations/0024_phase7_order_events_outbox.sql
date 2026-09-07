-- Migration 0024 — Phase 7 (7/10): order events outbox + side-effect delivery log.
--
-- TRANSACTIONAL OUTBOX: every order/order-item state change is FIRST written
-- to order_events_outbox INSIDE the same database transaction as the change
-- itself (no gap between the write and the broadcast — the same
-- "immutable evidence first" principle as the Phase-6 tax snapshots). The
-- broadcast layer (WebSocket primary / short-polling fallback) only READS
-- this table; a broadcast without a durable row is structurally impossible.
--
-- sequence_id is STRICTLY INCREASING and GAPLESS PER BRANCH: allocated from
-- order_event_sequences under a row lock in the same transaction, so a
-- rollback releases the number (no hole) and a commit guarantees the event
-- row. A reconnecting client (or the future Local Branch Gateway, which can
-- subscribe and cache a LAN-only replica and auto-resync when the external
-- link returns) replays "everything after my last sequence_id" with NO lost
-- events and no unobservable gaps.
--
-- side_effect_delivery_log implements the CLAIM-THEN-EXECUTE idempotency
-- ledger: UNIQUE (outbox_event_id, side_effect_type). A worker INSERTs
-- 'pending' first (ON CONFLICT does nothing); the insert succeeds → it owns
-- the execution; the insert conflicts → an earlier attempt exists
-- ('succeeded' → skip entirely, 'failed'/stale 'pending' → retry on the SAME
-- row with attempt_count + 1). At-least-once event delivery, EXACTLY-ONCE
-- external effect (a kitchen ticket is never printed twice, a customer never
-- notified twice). Required side-effect types are derived ONLY from the
-- platform kind behavior_flags carried in the event payload.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

-- Per-branch gapless sequence counter. Tenant-owned (RLS) so the allocation
-- stays inside the tenant boundary.
CREATE TABLE IF NOT EXISTS order_event_sequences (
  branch_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_order_event_sequences_tenant_id ON order_event_sequences (tenant_id);

ALTER TABLE order_event_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_event_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_event_sequences;
CREATE POLICY tenant_isolation ON order_event_sequences
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS order_events_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  -- Gapless, strictly increasing PER BRANCH (see header). The UNIQUE
  -- constraint makes a duplicate number structurally impossible.
  sequence_id bigint NOT NULL CHECK (sequence_id > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT order_events_outbox_branch_sequence UNIQUE (branch_id, sequence_id)
);
CREATE INDEX IF NOT EXISTS idx_order_events_outbox_tenant_id ON order_events_outbox (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_events_outbox_branch ON order_events_outbox (branch_id, sequence_id);

ALTER TABLE order_events_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_events_outbox;
CREATE POLICY tenant_isolation ON order_events_outbox
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The outbox itself is append-only evidence: no UPDATE, no DELETE.
DROP TRIGGER IF EXISTS trg_order_events_outbox_immutable ON order_events_outbox;
CREATE TRIGGER trg_order_events_outbox_immutable BEFORE UPDATE OR DELETE ON order_events_outbox
  FOR EACH ROW EXECUTE FUNCTION prevent_order_evidence_mutation();

-- Gapless per-branch allocation: INSERT-once, then a locked increment that
-- serializes concurrent transactions on the same branch. The number is only
-- visible when the allocating transaction commits (rollback releases it), so
-- the committed sequence per branch is a strict 1..N with no holes.
CREATE FUNCTION next_order_event_sequence(p_branch uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_seq bigint;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.branches WHERE id = p_branch;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'branch % not found for outbox sequencing', p_branch USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.order_event_sequences (branch_id, tenant_id, last_sequence)
    VALUES (p_branch, v_tenant, 0)
  ON CONFLICT (branch_id) DO NOTHING;
  UPDATE public.order_event_sequences SET last_sequence = last_sequence + 1
    WHERE branch_id = p_branch
    RETURNING last_sequence INTO v_seq;
  RETURN v_seq;
END;
$$;

CREATE FUNCTION append_order_event(p_tenant uuid, p_branch uuid, p_event_type text, p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_seq bigint;
BEGIN
  v_seq := public.next_order_event_sequence(p_branch);
  INSERT INTO public.order_events_outbox (tenant_id, branch_id, sequence_id, event_type, payload)
    VALUES (p_tenant, p_branch, v_seq, p_event_type, COALESCE(p_payload, '{}'::jsonb));
  RETURN v_seq;
END;
$$;

-- CLAIM-THEN-EXECUTE ledger (see header). Ownership follows the outbox row —
-- never a guessed tenant id (same pattern as order_line_tax_snapshots).
CREATE TABLE IF NOT EXISTS side_effect_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id uuid NOT NULL REFERENCES order_events_outbox (id) ON DELETE RESTRICT,
  side_effect_type text NOT NULL CHECK (side_effect_type IN ('kitchen_ticket_print', 'customer_notification')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT side_effect_delivery_unique_attempt UNIQUE (outbox_event_id, side_effect_type)
);
CREATE INDEX IF NOT EXISTS idx_side_effect_delivery_status ON side_effect_delivery_log (status);

ALTER TABLE side_effect_delivery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE side_effect_delivery_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_side_effect_parent_isolation ON side_effect_delivery_log;
CREATE POLICY order_side_effect_parent_isolation ON side_effect_delivery_log
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.order_events_outbox e
    WHERE e.id = side_effect_delivery_log.outbox_event_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.order_events_outbox e
    WHERE e.id = side_effect_delivery_log.outbox_event_id));

-- ── Wire the state-change cascade to the outbox (same triggers, upgraded
--    function bodies — migration 0023 declared the triggers; these CREATE OR
--    REPLACE versions additionally append the outbox rows in the same
--    transaction) ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION apply_order_item_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_branch uuid; v_flags jsonb;
BEGIN
  PERFORM set_config('app.orders_derived_write', '1', true);
  UPDATE public.order_items SET current_status_kind_id = NEW.to_status_kind_id
    WHERE id = NEW.order_item_id AND tenant_id = NEW.tenant_id;
  PERFORM set_config('app.orders_derived_write', '', true);
  SELECT o.branch_id INTO v_branch FROM public.orders o
    WHERE o.id = NEW.order_id AND o.tenant_id = NEW.tenant_id;
  SELECT k.behavior_flags INTO v_flags
    FROM public.tenant_order_workflow_states s
    JOIN public.order_status_kinds k ON k.code = s.kind_code
    WHERE s.id = NEW.to_status_kind_id;
  PERFORM public.append_order_event(NEW.tenant_id, v_branch, 'order_item.status_changed', jsonb_build_object(
    'order_id', NEW.order_id,
    'order_item_id', NEW.order_item_id,
    'from_status_kind_id', NEW.from_status_kind_id,
    'to_status_kind_id', NEW.to_status_kind_id,
    'actor_user_id', NEW.actor_user_id,
    'occurred_at', NEW.occurred_at,
    'behavior_flags', COALESCE(v_flags, '{}'::jsonb)));
  PERFORM recompute_order_status(NEW.tenant_id, NEW.order_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION recompute_order_status(p_tenant uuid, p_order uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_current uuid; v_target uuid; v_terminal boolean; v_branch uuid;
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
  SELECT o.branch_id INTO v_branch FROM public.orders o WHERE o.id = p_order AND o.tenant_id = p_tenant;
  PERFORM set_config('app.orders_derived_write', '1', true);
  UPDATE public.orders SET current_status_kind_id = v_target,
    closed_at = CASE WHEN v_terminal AND closed_at IS NULL THEN now() ELSE closed_at END
    WHERE id = p_order AND tenant_id = p_tenant;
  PERFORM set_config('app.orders_derived_write', '', true);
  PERFORM public.append_order_event(p_tenant, v_branch, 'order.status_changed', jsonb_build_object(
    'order_id', p_order,
    'from_status_kind_id', v_current,
    'to_status_kind_id', v_target,
    'is_terminal', v_terminal));
  RETURN v_target;
END;
$$;

REVOKE ALL ON order_events_outbox, order_event_sequences, side_effect_delivery_log FROM PUBLIC;
REVOKE ALL ON FUNCTION next_order_event_sequence(uuid), append_order_event(uuid, uuid, text, jsonb) FROM PUBLIC;
