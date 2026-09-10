/**
 * KDS device-token credentials (Backlog R1) — domain port.
 *
 * Each row of `kds_device_tokens` is ONE credential minted for ONE branch's
 * KDS stream (kitchen screen, expediter display, Local Branch Gateway). The
 * plaintext token is returned EXACTLY ONCE at issuance and never persisted;
 * only its sha256-hex is stored. Verification (tenant_id, token_hash,
 * status='active', branch match) is the authentication path for the KDS
 * realtime server's WebSocket upgrades and polling reads.
 */

export type KdsDeviceTokenStatus = 'active' | 'revoked';

export interface NewKdsDeviceTokenInput {
  readonly branchId: string;
  readonly label: string;
}

export interface KdsDeviceTokenRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly tokenHash: string;
  readonly status: KdsDeviceTokenStatus;
  readonly label: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/**
 * The issuance result. `plaintextToken` exists HERE and NOWHERE else — the
 * caller must display it once; it can never be recovered afterwards.
 */
export interface IssuedKdsDeviceToken {
  readonly record: KdsDeviceTokenRecord;
  readonly plaintextToken: string;
}

export interface KdsDeviceTokenTxScope {
  insertDeviceToken(
    tenantId: string,
    input: { readonly branchId: string; readonly tokenHash: string; readonly label: string; readonly createdBy: string },
  ): Promise<KdsDeviceTokenRecord>;
  loadDeviceTokenById(tenantId: string, tokenId: string): Promise<KdsDeviceTokenRecord | null>;
  loadDeviceTokenByHash(tenantId: string, tokenHash: string): Promise<KdsDeviceTokenRecord | null>;
  revokeDeviceToken(tenantId: string, tokenId: string): Promise<KdsDeviceTokenRecord>;
  /**
   * Throttled heartbeat: sets last_used_at=now() ONLY when it is NULL or
   * older than 60s, so per-poll verifications do not rewrite the row.
   */
  touchDeviceTokenLastUsed(tenantId: string, tokenId: string): Promise<void>;
}

// ── The KDS device-token store port ─────────────────────────────────────────

export interface KdsDeviceTokenStore {
  /** Runs fn in ONE transaction scoped to the tenant (repeatable read). */
  run<T>(tenantId: string, fn: (scope: KdsDeviceTokenTxScope) => Promise<T>): Promise<T>;
}
