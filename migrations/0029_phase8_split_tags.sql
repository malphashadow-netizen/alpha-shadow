-- Migration 0029 — Phase 8 (1/7): lightweight check-split tags.
--
-- Two purely additive columns, NO independent sub-invoices (independent
-- sub-invoices are a deliberately deferred Phase-8+ item — see
-- docs/phase8-payments.md):
--   * orders.split_people_count — DISPLAY ONLY: how many people the check is
--     being split across. It never enters any money calculation.
--   * order_items.split_group_id — a light grouping TAG for item-level check
--     splitting. Items sharing a tag are collected together; there is exactly
--     one order, one payment collection and one total either way.
--
-- split_group_id is order-time evidence and is frozen like the rest of the
-- purchase snapshot: guard_order_item_writes (migration 0022) is recreated
-- here with the additional frozen column. 0022 itself is NOT rewritten (same
-- hotfix-on-top discipline as 0009 over 0008).
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, RLS unaffected (existing
-- tables keep their policies).

ALTER TABLE orders ADD COLUMN IF NOT EXISTS split_people_count integer;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_split_people_count_positive;
ALTER TABLE orders ADD CONSTRAINT orders_split_people_count_positive
  CHECK (split_people_count IS NULL OR split_people_count > 0);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS split_group_id text;

-- Recreated from 0022 with split_group_id added to the immutable evidence set.
CREATE OR REPLACE FUNCTION guard_order_item_writes() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW.split_group_id IS DISTINCT FROM OLD.split_group_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'order item purchase evidence (name/price/quantity/modifiers/split group) is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.current_status_kind_id IS DISTINCT FROM OLD.current_status_kind_id
       AND NULLIF(current_setting('app.orders_derived_write', true), '') IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'order_items.current_status_kind_id is derived from order_item_status_events; direct writes are forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
