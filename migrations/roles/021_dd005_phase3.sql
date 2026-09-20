-- DD-005 phase 3: application access to immutable restoration evidence.
REVOKE ALL ON restoration_allocations FROM app_login;
GRANT SELECT, INSERT ON restoration_allocations TO app_login;
GRANT USAGE, SELECT ON SEQUENCE restoration_allocations_id_seq TO app_login;
REVOKE ALL ON FUNCTION post_inventory_restoration(uuid, uuid, uuid, timestamptz) FROM app_login;
GRANT EXECUTE ON FUNCTION post_inventory_restoration(uuid, uuid, uuid, timestamptz) TO app_login;
