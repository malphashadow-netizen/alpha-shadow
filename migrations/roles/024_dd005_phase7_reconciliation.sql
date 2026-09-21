-- DD-005 phase 7: least-privilege per-tenant reconciliation role.
-- Apply manually as a cluster role script, then activate LOGIN with a secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_batch') THEN
    CREATE ROLE app_batch NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_batch;

REVOKE ALL ON
  inventory_items,
  stock_movements,
  inventory_cost_ledger,
  inventory_cost_layers,
  consumption_allocations,
  restoration_allocations
FROM app_batch;

GRANT SELECT ON
  inventory_items,
  stock_movements,
  inventory_cost_ledger,
  inventory_cost_layers,
  consumption_allocations,
  restoration_allocations
TO app_batch;

GRANT EXECUTE ON FUNCTION reconcile_inventory(uuid) TO app_batch;
GRANT EXECUTE ON FUNCTION record_inventory_reconciliation(uuid, timestamptz, timestamptz) TO app_batch;
