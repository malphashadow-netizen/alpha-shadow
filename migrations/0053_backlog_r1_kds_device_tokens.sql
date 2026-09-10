-- Migration 0053 — Backlog (R1): KDS device-token credentials.
--
-- WHAT: a new tenant-scoped table `kds_device_tokens`. Each row is ONE
-- credential minted for ONE branch's KDS stream (kitchen screen, expediter
-- display, Local Branch Gateway). The KDS realtime server (Phase 7 broadcast
-- layer) currently accepts tokenless connections — R1 closes that gap: every
-- WebSocket upgrade and every polling GET must present a token whose
-- sha256-hex matches an ACTIVE row for the URL's tenant+branch, or the
-- connection is rejected BEFORE any outbox replay.
--
-- SECURITY NOTES (read before touching this table):
--   * `token_hash` stores sha256-hex ONLY. The plaintext token exists for
--     exactly one engine call (`issueDeviceToken` returns it once) and is
--     NEVER persisted — a database dump yields no usable credential.
--   * Lookup is ALWAYS (tenant_id, token_hash) + status='active' + the URL
--     branch must equal the token row's branch_id: a token minted for
--     branch B1 authenticates ONLY B1's stream; cross-branch presentation
--     is rejected.
--   * Revocation is a status flip (rows are NEVER deleted — the audit trail
--     of minted credentials survives). The server ALSO drops already-open
--     WebSocket connections on that token and re-validates survivors.
--   * UNIQUE(tenant_id, token_hash): token hashes are unguessable 256-bit
--     values; the per-tenant uniqueness is the isolation-correct form (a
--     global UNIQUE would leak cross-tenant existence via conflict errors).
--   * Branch tenancy is enforced by the composite FK (0033 payment_methods
--     precedent): a token can never point at another tenant's branch.
--   * `created_by` (who minted) is audit metadata, never an auth path. The
--     plain REFERENCES is sufficient: under the app role's RLS a
--     cross-tenant user row is invisible, so the FK check itself rejects a
--     cross-tenant pointer (0003 defence-in-depth note).
--   * ON DELETE RESTRICT on both FKs: offboarding a minter or deleting a
--     branch with live tokens is REFUSED until the tokens are explicitly
--     revoked — minted credentials must never silently orphan.
--
-- DEPENDS ON: 0003 (branches, users), 0033 (composite-FK precedent only).

CREATE TABLE IF NOT EXISTS kds_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  branch_id uuid NOT NULL,
  -- Lowercase sha256-hex (64 chars) of the plaintext token. The regex CHECK
  -- pins the engine's hash format at the database boundary too.
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Human label for the screen inventory ("Grill KDS 1"). Empty when the
  -- issuer did not name the device.
  label text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Last successful verification (connect-time on WebSocket, throttled on
  -- polling). NULL = minted but never used.
  last_used_at timestamptz,
  CONSTRAINT kds_device_tokens_tenant_hash_key UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branches (id, tenant_id) ON DELETE RESTRICT
);

-- REQUIRED: tenant_id is the RLS/query hot path — always index it.
CREATE INDEX IF NOT EXISTS idx_kds_device_tokens_tenant_id ON kds_device_tokens (tenant_id);
-- Verification hot path: (tenant_id, token_hash) is covered by the UNIQUE;
-- this index serves the branch-inventory listing (tokens of branch B).
CREATE INDEX IF NOT EXISTS idx_kds_device_tokens_tenant_branch ON kds_device_tokens (tenant_id, branch_id);

ALTER TABLE kds_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE kds_device_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON kds_device_tokens;
CREATE POLICY tenant_isolation ON kds_device_tokens
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
