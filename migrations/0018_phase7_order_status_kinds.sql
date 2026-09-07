-- Migration 0018 — Phase 7 (1/10): platform-level order status kinds.
--
-- Platform-owned, fixed reference data. A tenant can NEVER create, mutate or
-- delete an order status kind: tenants select a SUBSET of these kinds, order
-- them and label them in their own workflow (migration 0019). The behavior of
-- a status (kitchen ticket, payment collection, customer notification,
-- terminality, financial close) is bound to THIS platform kind — never to the
-- tenant's free label — exactly like the Phase-6 tax engine binds behavior to
-- the platform tax family, not to a tenant display name.
--
-- Style notes (same conventions as 0001–0017, enforced by
-- tools/check-migrations.ts and test/contract/rls-coverage.test.ts):
--   * Idempotent: CREATE … IF NOT EXISTS / ON CONFLICT DO NOTHING /
--     DROP TRIGGER IF EXISTS (re-runnable).
--   * NO `DROP TABLE` and NO `DROP … CASCADE` in this file.
--   * This table has NO tenant_id column by design (platform registry, same
--     class as permissions_registry / sales_channels), so the tenant RLS
--     template does not apply. Tenant mutation is blocked structurally by the
--     guard trigger below (a tenant GUC context may not write platform order
--     reference data) plus the SELECT-only grants in migrations/roles/007.
--   * Seeded platform reference data follows the sales_channels precedent
--     from migration 0011 (data, never code).

CREATE TABLE IF NOT EXISTS order_status_kinds (
  code text PRIMARY KEY CHECK (btrim(code) <> ''),
  name jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  -- Fixed behavior vocabulary (validated by the trigger below: exactly the
  -- five platform flags, every value a JSON boolean).
  behavior_flags jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_status_kinds_flags_are_objects CHECK (jsonb_typeof(behavior_flags) = 'object')
);

-- CHECK constraints cannot contain subqueries in PostgreSQL, so the strict
-- key vocabulary + boolean values are enforced by this trigger.
CREATE FUNCTION validate_order_status_kind_flags() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_keys text[];
BEGIN
  SELECT array_agg(k) INTO v_keys FROM jsonb_object_keys(NEW.behavior_flags) k;
  IF v_keys IS NULL OR array_length(v_keys, 1) <> 5
     OR NOT NEW.behavior_flags ?& ARRAY['fires_kitchen_ticket', 'opens_payment_collection', 'notifies_customer', 'is_terminal', 'is_financial_close'] THEN
    RAISE EXCEPTION 'behavior_flags must contain exactly the five platform flags' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.behavior_flags) e WHERE jsonb_typeof(e.value) <> 'boolean') THEN
    RAISE EXCEPTION 'behavior_flags values must all be JSON booleans' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_status_kind_flags ON order_status_kinds;
CREATE TRIGGER trg_validate_order_status_kind_flags BEFORE INSERT OR UPDATE ON order_status_kinds
  FOR EACH ROW EXECUTE FUNCTION validate_order_status_kind_flags();

-- Platform write guard: identical semantics to guard_platform_tax_write()
-- (migration 0010). Any connection carrying a tenant context is refused;
-- platform evolution happens exclusively outside a tenant context with DBA
-- authority (see migrations/roles/007_phase7_orders.sql).
CREATE FUNCTION guard_platform_order_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'platform order/void reference data cannot be mutated in a tenant context' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_order_status_kind_write ON order_status_kinds;
CREATE TRIGGER trg_platform_order_status_kind_write BEFORE INSERT OR UPDATE OR DELETE ON order_status_kinds
  FOR EACH ROW EXECUTE FUNCTION guard_platform_order_write();

REVOKE ALL ON order_status_kinds FROM PUBLIC;

-- Fixed platform vocabulary (Phase 7 spec). Behavior is bound to the kind:
--   received           – order accepted, customer notified
--   confirmed          – accepted by staff, customer notified
--   preparing          – kitchen ticket fires for the station
--   ready              – payment collection may open (QSR pay-at-counter) and
--                        the customer is notified
--   out_for_delivery   – customer notified
--   delivered          – terminal
--   cancelled          – terminal (void audit lives in order_voids)
--   refunded           – terminal + financial close (payments phase)
INSERT INTO order_status_kinds (code, name, behavior_flags) VALUES
  ('received', '{"ar":"مستلم","en":"Received"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":false,"notifies_customer":true,"is_terminal":false,"is_financial_close":false}'),
  ('confirmed', '{"ar":"مؤكد","en":"Confirmed"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":false,"notifies_customer":true,"is_terminal":false,"is_financial_close":false}'),
  ('preparing', '{"ar":"قيد التحضير","en":"Preparing"}',
    '{"fires_kitchen_ticket":true,"opens_payment_collection":false,"notifies_customer":false,"is_terminal":false,"is_financial_close":false}'),
  ('ready', '{"ar":"جاهز","en":"Ready"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":true,"notifies_customer":true,"is_terminal":false,"is_financial_close":false}'),
  ('out_for_delivery', '{"ar":"في الطريق للتوصيل","en":"Out for delivery"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":false,"notifies_customer":true,"is_terminal":false,"is_financial_close":false}'),
  ('delivered', '{"ar":"تم التسليم","en":"Delivered"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":false,"notifies_customer":true,"is_terminal":true,"is_financial_close":false}'),
  ('cancelled', '{"ar":"ملغي","en":"Cancelled"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":false,"notifies_customer":false,"is_terminal":true,"is_financial_close":false}'),
  ('refunded', '{"ar":"مُستَرد","en":"Refunded"}',
    '{"fires_kitchen_ticket":false,"opens_payment_collection":false,"notifies_customer":true,"is_terminal":true,"is_financial_close":true}')
ON CONFLICT (code) DO NOTHING;
