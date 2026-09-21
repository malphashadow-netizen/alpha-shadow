-- DD-005 phase 8 application grants.
REVOKE ALL ON inventory_provisional_cost_settlements FROM app_login;
GRANT SELECT ON inventory_provisional_cost_settlements TO app_login;
GRANT EXECUTE ON FUNCTION post_inventory_adjustment(uuid, uuid, uuid, timestamptz) TO app_login;
