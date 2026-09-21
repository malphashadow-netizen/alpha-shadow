-- DD-005 phase 4: application access to the full-settlement COGS posting.
GRANT SELECT ON consumption_allocations, restoration_allocations TO app_login;
REVOKE ALL ON FUNCTION post_order_cogs(uuid, uuid, uuid, timestamptz) FROM app_login;
GRANT EXECUTE ON FUNCTION post_order_cogs(uuid, uuid, uuid, timestamptz) TO app_login;
