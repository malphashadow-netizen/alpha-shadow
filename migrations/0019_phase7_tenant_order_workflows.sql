-- Migration 0019 — Phase 7 (2/10): tenant-defined order workflows.
--
-- Every tenant defines its OWN sequence: which platform order_status_kinds it
-- uses (a subset), their order, its own localized labels and sub-states
-- (e.g. "preparing – waiting for ingredient"). Transitions are validated
-- against THIS sequence (fail-closed: a free-form state machine is forbidden).
--
-- Modification contract (fail-closed, spec-mandated):
--   * HARD DELETE of a tenant_order_workflow_state is ALWAYS rejected while
--     any row — active or archived — in orders / order_items /
--     order_item_status_events references it: the FKs below are
--     ON DELETE RESTRICT (orders/items/events reference states in 0021–0023)
--     and the application layer pre-checks for a clean, explicit error. The
--     audit trail is permanent; there is no exception, not even for archived
--     orders.
--   * SOFT DISABLE (is_enabled = false) is ALWAYS allowed, at any time: the
--     state disappears from NEW transition options only (engines load enabled
--     states exclusively) and no historical order that points at it changes.
--     Same pattern as tenant_void_reason_kind_settings (migration 0026).
--   * REORDERING (position) is ALWAYS allowed: orders reference the state row
--     id, never its position, so historical rows are immune to reordering.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template on
-- every tenant_id table (ENABLE + FORCE + tenant_isolation FOR ALL).

CREATE TABLE IF NOT EXISTS tenant_order_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- Exactly one workflow per tenant is effective today; the single row makes
  -- "the tenant's effective sequence" unambiguous.
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_order_workflows_tenant_unique UNIQUE (tenant_id),
  CONSTRAINT tenant_order_workflows_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_order_workflows_tenant_id ON tenant_order_workflows (tenant_id);

ALTER TABLE tenant_order_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_order_workflows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_order_workflows;
CREATE POLICY tenant_isolation ON tenant_order_workflows
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS tenant_order_workflow_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  workflow_id uuid NOT NULL,
  -- The platform kind whose fixed behavior_flags drive this state.
  kind_code text NOT NULL REFERENCES order_status_kinds (code),
  -- Sub-state refinement of a parent kind (e.g. "preparing – waiting for
  -- ingredient"). NULL = top-level state. A sub-state always refines its own
  -- parent kind, so behavior and order-level aggregation are unambiguous.
  parent_kind_code text REFERENCES order_status_kinds (code),
  -- Strict total order inside the workflow: positions are unique, which makes
  -- the derived parent-order status deterministic (no ties to break).
  position integer NOT NULL CHECK (position >= 0),
  label jsonb NOT NULL CHECK (jsonb_typeof(label) = 'object'),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_order_workflow_states_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT tenant_order_workflow_states_sub_kind CHECK (parent_kind_code IS NULL OR parent_kind_code = kind_code),
  CONSTRAINT tenant_order_workflow_states_unique_position UNIQUE (workflow_id, position),
  FOREIGN KEY (workflow_id, tenant_id) REFERENCES tenant_order_workflows (id, tenant_id) ON DELETE RESTRICT
);
-- One top-level state per kind per workflow; sub-states are unique per label.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_workflow_states_top_level
  ON tenant_order_workflow_states (workflow_id, kind_code) WHERE parent_kind_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_workflow_states_sub_label
  ON tenant_order_workflow_states (workflow_id, kind_code, label) WHERE parent_kind_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_order_workflow_states_tenant_id ON tenant_order_workflow_states (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_order_workflow_states_workflow ON tenant_order_workflow_states (workflow_id, position);

ALTER TABLE tenant_order_workflow_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_order_workflow_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_order_workflow_states;
CREATE POLICY tenant_isolation ON tenant_order_workflow_states
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- A state row must belong to the tenant's own workflow (cross-tenant or
-- cross-workflow references are structurally impossible).
CREATE FUNCTION validate_tenant_order_workflow_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_order_workflows w
    WHERE w.id = NEW.workflow_id AND w.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'workflow state must belong to a workflow of the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_tenant_order_workflow_state ON tenant_order_workflow_states;
CREATE TRIGGER trg_validate_tenant_order_workflow_state BEFORE INSERT OR UPDATE ON tenant_order_workflow_states
  FOR EACH ROW EXECUTE FUNCTION validate_tenant_order_workflow_state();

REVOKE ALL ON tenant_order_workflows, tenant_order_workflow_states FROM PUBLIC;
