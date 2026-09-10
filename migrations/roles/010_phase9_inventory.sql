-- migrations/roles/010_phase9_inventory.sql — MANUAL, ONE-TIME DBA script.
--
-- ⚠️ THIS FILE IS NOT PART OF THE NORMAL MIGRATION CYCLE. ⚠️
-- Same provisioning contract as migrations/roles/006–009: run once per
-- environment with DBA authority AFTER migration 0040, never through
-- tools/migrate.ts (which only reads top-level migrations/*.sql).
--
-- Least-privilege grants for the Phase-9 inventory surface:
--   * inventory_items: SELECT + INSERT + UPDATE. The UPDATE is mandatory: the
--     apply_stock_movement trigger (0040) executes with the invoker's
--     privileges, so the balance write needs it. NO DELETE: stocked rows are
--     archived with is_active = false, never physically removed (the ledger
--     references them RESTRICTively anyway).
--   * unit_conversions / menu_item_recipes / modifier_recipes: full CRUD —
--     admin-managed master data (same grant shape as the Phase-5 catalog
--     tables in roles/005); RESTRICT FKs still protect referenced rows.
--   * recipe_ingredients: SELECT-only (a security_invoker read view over the
--     two recipe tables; RLS is enforced as the caller on every row).
--   * stock_movements / stock_override_claims: the append-only ledgers —
--     SELECT + INSERT only, with an explicit REVOKE of UPDATE/DELETE
--     (immutability is additionally enforced by the 55006 triggers, 0040).

-- Branch-scoped stock rows (trigger-applied balances need UPDATE).
REVOKE ALL ON inventory_items FROM app_login;
GRANT SELECT, INSERT, UPDATE ON inventory_items TO app_login;

-- Admin-managed master data (catalog-parity CRUD).
REVOKE ALL ON unit_conversions, menu_item_recipes, modifier_recipes FROM app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON unit_conversions, menu_item_recipes, modifier_recipes TO app_login;

-- Read-only recipe view.
REVOKE ALL ON recipe_ingredients FROM app_login;
GRANT SELECT ON recipe_ingredients TO app_login;

-- Append-only ledgers (claims are single-use: INSERT once, never changed).
REVOKE ALL ON stock_movements, stock_override_claims FROM app_login;
GRANT SELECT, INSERT ON stock_movements, stock_override_claims TO app_login;
REVOKE UPDATE, DELETE ON stock_movements, stock_override_claims FROM app_login;
