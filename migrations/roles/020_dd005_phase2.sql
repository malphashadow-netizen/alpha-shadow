-- MANUAL, ONE-TIME DBA script. Run after migration 0070.
REVOKE ALL ON consumption_allocations FROM app_login;
GRANT SELECT, INSERT ON consumption_allocations TO app_login;
GRANT EXECUTE ON FUNCTION post_inventory_consumption(uuid, uuid, uuid, uuid, timestamptz) TO app_login;
