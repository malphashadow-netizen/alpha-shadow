-- DD-005 phase 5 application grants.
REVOKE ALL ON adjustment_cost_allocations FROM app_login;
GRANT SELECT, INSERT ON adjustment_cost_allocations TO app_login;
GRANT USAGE, SELECT ON SEQUENCE adjustment_cost_allocations_id_seq TO app_login;
GRANT EXECUTE ON FUNCTION post_inventory_adjustment(uuid, uuid, uuid, timestamptz) TO app_login;
