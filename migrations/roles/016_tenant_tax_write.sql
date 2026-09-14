-- Tenant-owned tax configuration; platform reference-tax grants are unchanged.
GRANT SELECT, INSERT, UPDATE ON tenant_tax_categories, tenant_tax_rates TO app_login;
GRANT EXECUTE ON FUNCTION create_tenant_tax_rate(uuid, uuid, integer, boolean, date, date) TO app_login;
GRANT EXECUTE ON FUNCTION close_and_supersede_tenant_tax_rate(uuid, uuid, integer, boolean, date) TO app_login;
