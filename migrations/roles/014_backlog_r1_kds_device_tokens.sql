-- Roles 014 — Backlog (R1): grants for the KDS device-token credentials.
--
-- MANUAL DBA FILE (007 kinds mirror): applied by the DBA alongside
-- migration 0053. The app role issues, verifies, revokes, and touches
-- last_used_at on kds_device_tokens; rows are NEVER deleted (revocation is
-- a status flip — the minted-credential audit trail survives), so there is
-- deliberately NO DELETE grant.
--
-- ── KDS device tokens (migration 0053) ──────────────────────────────────
REVOKE ALL ON kds_device_tokens FROM app_login;
GRANT SELECT, INSERT, UPDATE ON kds_device_tokens TO app_login;
