-- Migration 0027 — Phase 7 (10/10): order voids (immutable append-only audit).
--
-- EVERY void / void-modification is recorded here, permanently. No UPDATE, no
-- DELETE (same pattern as order_line_tax_snapshots, 0017). The row snapshots:
--   * actor identity + the actor's permission TIER at void time,
--   * the tenant void reason used,
--   * whether a manager override was required and — if so — the override
--     manager's identity PLUS override_authenticated_at, the timestamp of the
--     LIVE PIN challenge that authorized the override at the exact moment of
--     the void (a name picked from a list is NEVER accepted; the engine
--     verifies the manager's separate PIN at void time — see
--     PostgresManagerOverrideAuthenticator — and this table refuses a manager
--     identity without the matching authentication timestamp),
--   * the order's payment_status AT VOID TIME (evidence snapshot).
--
-- FAIL-CLOSED on paid orders: the void engine refuses any void on
-- payment_status <> 'open' with PaymentReversalRequiredError (the payments
-- phase is deferred; a paid void would need Void Payment → Reopen →
-- Void Item → re-collection). The validation trigger below enforces the same
-- policy AT THE DATABASE LEVEL: an order_voids row for a non-open order can
-- never be inserted, whatever the code path.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.

CREATE TABLE IF NOT EXISTS order_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  order_id uuid NOT NULL,
  -- NULL = whole-order void; NOT NULL = single item void (must belong to
  -- order_id — checked by the validation trigger).
  order_item_id uuid,
  actor_user_id uuid NOT NULL,
  actor_permission_tier text NOT NULL CHECK (actor_permission_tier IN ('server', 'shift_supervisor', 'manager')),
  void_reason_id uuid NOT NULL,
  required_manager_override boolean NOT NULL,
  manager_user_id uuid,
  override_authenticated_at timestamptz,
  order_payment_status_at_void_time text NOT NULL
    CHECK (order_payment_status_at_void_time IN ('open', 'paid', 'refund_pending', 'refunded')),
  notes text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, tenant_id) REFERENCES orders (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id, tenant_id) REFERENCES order_items (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (void_reason_id, tenant_id) REFERENCES tenant_void_reasons (id, tenant_id) ON DELETE RESTRICT,
  -- A manager identity is only ever recorded together with its live
  -- authentication proof — and a void that REQUIRED an override can never be
  -- stored without the overriding manager (no silent bypass).
  CONSTRAINT order_voids_override_identity CHECK (
    (manager_user_id IS NULL AND override_authenticated_at IS NULL)
    OR (manager_user_id IS NOT NULL AND override_authenticated_at IS NOT NULL)),
  CONSTRAINT order_voids_override_evidence CHECK (
    NOT required_manager_override OR manager_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_order_voids_tenant_id ON order_voids (tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_voids_order ON order_voids (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_order_voids_actor ON order_voids (tenant_id, actor_user_id, occurred_at);

ALTER TABLE order_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_voids FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON order_voids;
CREATE POLICY tenant_isolation ON order_voids
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP TRIGGER IF EXISTS trg_order_voids_immutable ON order_voids;
CREATE TRIGGER trg_order_voids_immutable BEFORE UPDATE OR DELETE ON order_voids
  FOR EACH ROW EXECUTE FUNCTION prevent_order_evidence_mutation();

-- DB-level permission assertion for the override manager (same shape as
-- assert_tenant_tax_permission, 0016): an active tenant member holding the
-- atomic permission key through an ACTIVE tenant-wide or branch-scoped grant.
CREATE FUNCTION assert_tenant_order_permission(p_actor uuid, p_permission text, p_branch uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tid uuid := current_setting('app.current_tenant_id')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
      JOIN public.tenants t ON t.id = u.tenant_id
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
      JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
      JOIN public.role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
    WHERE u.id = p_actor AND u.tenant_id = tid AND u.is_active AND t.status = 'active'
      AND ur.is_active
      AND (ur.scope_type = 'tenant' AND ur.scope_id IS NULL
           OR ur.scope_type = 'branch' AND ur.scope_id IS NOT DISTINCT FROM p_branch)
      AND rp.permission_key = p_permission
  ) THEN
    RAISE EXCEPTION 'active tenant permission % is required', p_permission USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Full structural validation of every audit row (fail-closed on all paths).
CREATE FUNCTION validate_order_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_payment text; v_item_order uuid;
BEGIN
  SELECT payment_status INTO v_payment FROM public.orders
    WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id;
  IF v_payment IS NULL THEN
    RAISE EXCEPTION 'void must reference an order of the same tenant' USING ERRCODE = '23514';
  END IF;
  -- Evidence integrity: the snapshot must equal the live payment status at
  -- insert time.
  IF NEW.order_payment_status_at_void_time <> v_payment THEN
    RAISE EXCEPTION 'order_voids.payment status snapshot must equal the order''s live payment status' USING ERRCODE = '23514';
  END IF;
  -- Fail-closed structural policy (Phase 7): a paid/refund-pending/refunded
  -- order can never be voided — the payments engine (future phase) owns the
  -- Void Payment → Reopen → Void Item → re-collection sequence. Removing this
  -- block is a deliberate, reviewed migration decision of that phase.
  IF v_payment <> 'open' THEN
    RAISE EXCEPTION 'PaymentReversalRequiredError: void on a % order requires the payments engine (fail closed)', v_payment USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
    RAISE EXCEPTION 'void actor must be an active user of the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW.order_item_id IS NOT NULL THEN
    SELECT order_id INTO v_item_order FROM public.order_items WHERE id = NEW.order_item_id AND tenant_id = NEW.tenant_id;
    IF v_item_order IS NULL OR v_item_order <> NEW.order_id THEN
      RAISE EXCEPTION 'voided item must belong to the voided order' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.manager_user_id IS NOT NULL THEN
    -- A live PIN challenge timestamp is mandatory evidence for any recorded
    -- manager identity (name-only overrides are structurally impossible).
    IF NEW.override_authenticated_at IS NULL THEN
      RAISE EXCEPTION 'manager override without a recorded live authentication timestamp is forbidden' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = NEW.manager_user_id AND u.tenant_id = NEW.tenant_id AND u.is_active) THEN
      RAISE EXCEPTION 'override manager must be an active user of the same tenant' USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_tenant_order_permission(NEW.manager_user_id, 'order:void:manager',
      (SELECT branch_id FROM public.orders WHERE id = NEW.order_id));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_void ON order_voids;
CREATE TRIGGER trg_validate_order_void BEFORE INSERT ON order_voids
  FOR EACH ROW EXECUTE FUNCTION validate_order_void();

REVOKE ALL ON order_voids FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_tenant_order_permission(uuid, text, uuid) FROM PUBLIC;
