-- Roles 013 — Backlog (I4): grants for the universal unit registry.
--
-- MANUAL DBA FILE (007 kinds mirror): applied by the DBA alongside
-- migration 0051. Platform reference data is SELECT-only for the app role;
-- the guard trigger rejects tenant-context writes structurally.

-- ── unit registry (migration 0051) ─────────────────────────────────────────
REVOKE ALL ON unit_registry FROM app_login;
GRANT SELECT ON unit_registry TO app_login;
