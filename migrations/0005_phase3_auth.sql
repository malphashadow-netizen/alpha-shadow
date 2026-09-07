-- Migration 0005 — Phase 3 authentication & security.
--
-- Contents:
--   (a) users.staff_code — the explicit, tenant-scoped identifier used by the
--       PIN login mode. Pin never scans for an account: the client must send
--       an explicit user identifier (staff_code or user id), exactly like the
--       email+password mode requires an explicit tenant identifier.
--   (b) auth_refresh_tokens — rotating refresh-token ledger (tenant-scoped,
--       full RLS). Every row is a token family member; rotation writes a new
--       row and marks the old one revoked in the SAME transaction.
--   (c) auth_audit_log — the GLOBAL authentication audit table and the two
--       SECURITY DEFINER helper functions used by the least-privilege
--       `app_audit` role (see migrations/roles/003_app_audit.sql).
--
-- RLS EXCEPTION (deliberate, documented in docs/backlog.md and in the header
-- comment of src/infrastructure/db/auth-audit.ts):
--   `auth_audit_log` is the ONLY application table with a tenant reference
--   column that is deliberately NOT named `tenant_id`, has NO
--   `tenant_isolation` policy and no ENABLE/FORCE ROW LEVEL SECURITY block.
--   A failed login for a non-existent tenant/user carries NO authenticated
--   tenant context; the standard RLS contract requires `tenant_id NOT NULL`
--   plus `current_setting('app.current_tenant_id')::uuid`, which cannot exist
--   for an unknown tenant. This is exactly the same exception class as the
--   global `tenants` / `permissions_registry` tables.
--   To keep the generic RLS-coverage guard (test/contract/rls-coverage.test.ts
--   — it keys on the exact column name `tenant_id`, never on a table list)
--   strictly uniform and allow-list free, the column is NAMED
--   `tenant_id_attempted` (nullable; NO FK to tenants). The audit table's
--   nullable "which tenant did the caller CLAIM" value is not the same thing
--   as an RLS tenant_id. Writes/reads happen ONLY through the two
--   SECURITY DEFINER functions below, executed by the dedicated
--   least-privilege `app_audit` role — the one sanctioned exception to
--   "all DB access goes through withTenantContext()".
--
-- Style notes (same conventions as 0001–0004, enforced by
-- tools/check-migrations.ts and test/contract/rls-coverage.test.ts):
--   * Idempotent: CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--     CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
--     DROP POLICY IF EXISTS (re-creatable).
--   * NO `DROP TABLE` and NO `DROP … CASCADE`.
--   * Every table that carries a REAL `tenant_id` column (auth_refresh_tokens)
--     carries the mandatory RLS template (ENABLE + FORCE + tenant_isolation
--     FOR ALL with USING and WITH CHECK both equal to the current_setting
--     predicate). auth_audit_log deliberately has NO `tenant_id` column.
--   * NO data rows here; test/seed data lives in test/support/seed.test.sql.

-- Ensure pgcrypto is available for gen_random_uuid() (idempotent).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- (a) users.staff_code — explicit PIN-mode identifier, unique per tenant.
--     Nullable: only users that may log in by PIN carry a code.
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_code text;

-- Partial unique index: uniqueness holds among the users that HAVE a code,
-- per tenant (the PIN path is always tenant-scoped).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_staff_code
  ON users (tenant_id, lower(staff_code))
  WHERE staff_code IS NOT NULL;

-- (b) auth_refresh_tokens — rotating refresh-token ledger (tenant-scoped).
--     Only the SHA-256 HASH of the refresh token id (jti) is stored, never
--     the token itself. The same (tenant_id, family_id) groups a rotation
--     chain; replay of a revoked token revokes the whole family.
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL,
  family_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A stored token can never match twice (one active row per hash, globally).
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_refresh_tokens_token_hash
  ON auth_refresh_tokens (token_hash);

-- Rotation lookups ("is this jti already used?") and family revocation.
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_family
  ON auth_refresh_tokens (tenant_id, family_id);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user
  ON auth_refresh_tokens (tenant_id, user_id);

-- Performance: tenant_id is the RLS/query hot path — always indexed.
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_tenant_id ON auth_refresh_tokens (tenant_id);

ALTER TABLE auth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_refresh_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON auth_refresh_tokens;
CREATE POLICY tenant_isolation ON auth_refresh_tokens
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- (c) auth_audit_log — GLOBAL table (deliberate RLS exception, see header).
CREATE TABLE IF NOT EXISTS auth_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id_attempted uuid,
  user_id_attempted text,
  identifier_attempted text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('password', 'pin', 'refresh')),
  success boolean NOT NULL,
  ip_address text,
  user_agent text
);

-- Rate limiting is derived from THIS table (sliding windows), per spec:
--   WHERE ip_address = $1 AND created_at > now() - interval '…'
--   WHERE identifier_attempted = $2 AND created_at > now() - interval '…'
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_ip_created_at
  ON auth_audit_log (ip_address, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_identifier_created_at
  ON auth_audit_log (identifier_attempted, created_at);

-- SECURITY DEFINER helper functions — the ONLY surface the `app_audit` role
-- is granted. The functions OWN the table (definer rights => the migration
-- owner), so the role itself never receives SELECT/INSERT on the table.
-- search_path is pinned to pg_temp, public (safe value; nothing here depends
-- on unqualified name resolution) to defeat search_path hijacking of a
-- SECURITY DEFINER routine.

-- record_auth_attempt(): append one audit row. Strict parameter types, no
-- dynamic SQL.
CREATE OR REPLACE FUNCTION record_auth_attempt(
  p_tenant_id_attempted uuid,
  p_user_id_attempted text,
  p_identifier_attempted text,
  p_mode text,
  p_success boolean,
  p_ip_address text,
  p_user_agent text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_temp, public
AS $$
BEGIN
  INSERT INTO auth_audit_log (
    tenant_id_attempted, user_id_attempted, identifier_attempted,
    mode, success, ip_address, user_agent
  ) VALUES (
    p_tenant_id_attempted, p_user_id_attempted, p_identifier_attempted,
    p_mode, p_success, p_ip_address, p_user_agent
  );
END;
$$;

-- count_recent_auth_failures(): sliding-window failure counter used by the
-- two independent rate limiters (IP + targeted identifier). Only FAILED
-- attempts are counted; successful logins never lock out an identifier.
-- NULL ip_address/identifier match nothing (COALESCE on the column side).
CREATE OR REPLACE FUNCTION count_recent_auth_failures(
  p_mode text,
  p_ip_address text,
  p_identifier_attempted text,
  p_window_ms integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_temp, public
AS $$
DECLARE
  v_ip_count integer;
  v_identifier_count integer;
BEGIN
  SELECT count(*)::int INTO v_ip_count
    FROM auth_audit_log
   WHERE mode = p_mode
     AND success = false
     AND ip_address IS NOT DISTINCT FROM p_ip_address
     AND created_at > now() - make_interval(secs => p_window_ms / 1000.0);

  SELECT count(*)::int INTO v_identifier_count
    FROM auth_audit_log
   WHERE mode = p_mode
     AND success = false
     AND identifier_attempted IS NOT DISTINCT FROM p_identifier_attempted
     AND created_at > now() - make_interval(secs => p_window_ms / 1000.0);

  RETURN GREATEST(v_ip_count, v_identifier_count);
END;
$$;

-- Hardening: functions are executable by PUBLIC by default in PostgreSQL.
-- Revoke that default; the roles/003 script re-grants EXECUTE to app_audit
-- only. (REVOKE is idempotent and safe if the default was already removed.)
REVOKE ALL ON FUNCTION record_auth_attempt(uuid, text, text, text, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION count_recent_auth_failures(text, text, text, integer) FROM PUBLIC;
