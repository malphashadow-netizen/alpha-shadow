-- MANUAL, ONE-TIME DBA script. This file is not applied by tools/migrate.ts or
-- the test harness. Run after 0068: psql "$MIGRATION_DATABASE_URL" -f migrations/roles/019_dd005_phase1.sql
REVOKE ALL ON inventory_cost_ledger, inventory_cost_layers FROM app_login;
GRANT SELECT, INSERT ON inventory_cost_ledger TO app_login;
GRANT SELECT, INSERT ON inventory_cost_layers TO app_login;
GRANT UPDATE (remaining_qty, remaining_cost_minor) ON inventory_cost_layers TO app_login;
REVOKE UPDATE, DELETE ON inventory_cost_ledger FROM app_login;
REVOKE DELETE ON inventory_cost_layers FROM app_login;
