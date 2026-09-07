-- MANUAL DBA role provisioning, AFTER 0017. Never part of tools/migrate.ts.
-- Activate platform_tax_admin LOGIN with a separate secret-manager credential
-- only on the isolated platform-admin service. Never GRANT this role to
-- app_login, tenant roles or any tenant-facing service principal.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_tax_admin') THEN
    CREATE ROLE platform_tax_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE platform_tax_admin NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO platform_tax_admin;
REVOKE platform_tax_admin FROM app_login;
REVOKE ALL ON tax_jurisdictions, tax_categories, tax_rates, sales_channels,
  delivery_platforms, tax_liability_rules FROM app_login, platform_tax_admin;
GRANT SELECT ON tax_jurisdictions, tax_categories, tax_rates, sales_channels,
  delivery_platforms, tax_liability_rules TO app_login, platform_tax_admin;
GRANT SELECT ON currencies TO platform_tax_admin;
GRANT INSERT, UPDATE ON tax_jurisdictions, tax_categories, sales_channels,
  delivery_platforms, tax_liability_rules TO platform_tax_admin;
-- No arbitrary tax_rates update or insert; audited functions are the ONLY path.
GRANT EXECUTE ON FUNCTION create_tax_rate(uuid, integer, boolean, date, date, uuid) TO platform_tax_admin;
GRANT EXECUTE ON FUNCTION close_and_supersede_tax_rate(uuid, integer, boolean, date, uuid) TO platform_tax_admin;
REVOKE ALL ON FUNCTION create_tax_rate(uuid, integer, boolean, date, date, uuid) FROM app_login;
REVOKE ALL ON FUNCTION close_and_supersede_tax_rate(uuid, integer, boolean, date, uuid) FROM app_login;
GRANT SELECT ON audit_log TO platform_tax_admin;
REVOKE INSERT, UPDATE, DELETE ON audit_log FROM platform_tax_admin;

REVOKE ALL ON branch_tax_category_overrides, menu_item_additional_tax_categories,
  menu_item_excise_confirmations, order_line_tax_contexts, order_line_tax_snapshots FROM app_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON branch_tax_category_overrides TO app_login;
GRANT SELECT, INSERT, DELETE ON menu_item_additional_tax_categories TO app_login;
GRANT SELECT ON menu_item_excise_confirmations TO app_login;
GRANT SELECT, INSERT ON order_line_tax_contexts, order_line_tax_snapshots TO app_login;
REVOKE UPDATE, DELETE ON order_line_tax_contexts, order_line_tax_snapshots FROM app_login;
GRANT EXECUTE ON FUNCTION confirm_menu_item_excise(uuid, uuid, text, uuid, text) TO app_login;
GRANT EXECUTE ON FUNCTION confirm_excise_branch_override(uuid, uuid, uuid, uuid[], uuid, text) TO app_login;
GRANT EXECUTE ON FUNCTION set_tenant_vat_registration(text, text, uuid) TO app_login;
-- Keep tenants global SELECT-only (registration uses its narrow function).
REVOKE INSERT, UPDATE, DELETE ON tenants FROM app_login;
