-- Migration 0037 — Phase 9 (1/6): inventory_items (per-branch stock).
--
-- One row per (branch, tracked component). Stock is BRANCH-SCOPED: every
-- branch counts its own quantity; central reporting aggregates across
-- branches with a plain read-only SELECT (no materialized rollup table).
--
-- Design notes (locked):
--   * name is a free-key localized JSONB object (same contract as
--     menu_items.name — no language allow-list).
--   * base_unit is free TEXT (data-driven, e.g. 'kg', 'liter', 'piece') —
--     never a closed enum. All recipe quantities are stored in this unit.
--   * current_quantity is NUMERIC(18,4) and crosses into TypeScript as exact
--     decimal TEXT through shared/decimal-text.ts (scale 4) — no float, ever.
--   * NO non-negative CHECK on current_quantity BY DESIGN: a manager-approved
--     sale into shortage (stock_override) legitimately drives the balance
--     below zero; the negative balance is a shortage signal for reports.
--     The override gate (manager_override_id + single-use claim) is enforced
--     by validate_stock_movement (0040) — negativity without evidence is
--     rejected there, at the database level.
--   * current_quantity is DERIVED from stock_movements: guard_inventory_item_writes
--     (0040) forbids every direct write outside the apply_stock_movement path
--     (same GUC tradition as app.orders_derived_write, 0022/0023).
--   * The branch FK runs under the caller's RLS (same defence as
--     users.branch_id, 0003): a cross-tenant branch pointer is an invisible
--     row, hence an FK violation. Movements re-assert the match explicitly.
--
-- Style notes: idempotent, no DROP TABLE / CASCADE, mandatory RLS template.
--
-- The three inventory permission keys seeded at the bottom are GLOBAL registry
-- rows (permissions_registry has no tenant_id), identical in every environment.
-- ON CONFLICT DO NOTHING — never DO UPDATE. inventory:adjust is sensitive:
-- a downward adjustment can hide shrinkage or theft.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
  name jsonb NOT NULL,
  base_unit text NOT NULL,
  current_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  low_stock_threshold NUMERIC(18,4) NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_items_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT inventory_items_name_object CHECK (jsonb_typeof(name) = 'object'),
  CONSTRAINT inventory_items_base_unit_nonempty CHECK (char_length(base_unit) BETWEEN 1 AND 32),
  CONSTRAINT inventory_items_threshold_nonnegative CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_id ON inventory_items (tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_branch ON inventory_items (tenant_id, branch_id);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON inventory_items;
CREATE POLICY tenant_isolation ON inventory_items
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

INSERT INTO permissions_registry (key, category, is_sensitive) VALUES
  ('inventory:read', 'inventory', false),
  ('inventory:receive', 'inventory', false),
  ('inventory:adjust', 'inventory', true)
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON inventory_items FROM PUBLIC;
