/**
 * KDS device-token administration (Backlog R1).
 *
 * Minting a token creates a CREDENTIAL for a branch's order stream — tenant
 * integration configuration, not branch operations. Both mutations are
 * therefore gated by the EXISTING payments:methods_admin key (sensitive):
 * it is the repo's explicit admin key for tenant-level configuration whose
 * rows are themselves branch-scoped (payment_methods.branch_id is the exact
 * precedent: tenant-wide admin gate, branch-scoped rows). The check is
 * tenant-scoped (actorBranchId: null) and cache-bypassing (sensitive), like
 * the payment-methods administration it mirrors.
 *
 * SECURITY CONTRACT:
 *   * issue() generates 256 crypto-random bits, base64url-encoded (43 chars,
 *     URL-safe — it travels in a WebSocket query string). The plaintext is
 *     returned ONCE inside IssuedKdsDeviceToken and NEVER persisted; only
 *     its sha256-hex is stored, so a database dump yields no credential.
 *   * verify() is the AUTHENTICATION path itself — it takes NO actor and
 *     performs NO permission check (the token IS the credential). EVERY
 *     failure mode (unknown hash, revoked status, branch mismatch, malformed
 *     input) returns the SAME { verified: false } with no reason code, so
 *     the response never oracles token existence, status, or home branch.
 *   * revoke() is an instant status flip; rows are never deleted. Re-revoking
 *     an already-revoked token is a success (idempotent — retry-safe).
 */
import { randomBytes } from 'node:crypto';

import type {
  IssuedKdsDeviceToken,
  KdsDeviceTokenRecord,
  KdsDeviceTokenStore,
  NewKdsDeviceTokenInput,
} from '../../../domain/contracts/kds.ts';
import type { AuthorizationEngine } from '../rbac/authorization-engine.ts';
import { sha256Hex } from '../../../shared/crypto.ts';
import { NotFoundError, ValidationError } from '../../../shared/errors.ts';

const KDS_DEVICE_ADMIN_PERMISSION_KEY = 'payments:methods_admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_LABEL_LENGTH = 200;

export interface KdsDeviceVerification {
  readonly verified: boolean;
  readonly tokenId: string | null;
  readonly tokenHash: string | null;
}

const VERIFICATION_FAILED: KdsDeviceVerification = { verified: false, tokenId: null, tokenHash: null };

export class KdsDeviceEngine {
  private readonly dependencies: { readonly store: KdsDeviceTokenStore; readonly authorization: Pick<AuthorizationEngine, 'check'> };

  constructor(dependencies: { readonly store: KdsDeviceTokenStore; readonly authorization: Pick<AuthorizationEngine, 'check'> }) {
    this.dependencies = dependencies;
  }

  /**
   * Mints a device token for ONE branch. Returns the plaintext ONCE — the
   * caller must display it now; it can never be recovered afterwards.
   */
  async issueDeviceToken(tenantId: string, actorUserId: string, input: NewKdsDeviceTokenInput): Promise<IssuedKdsDeviceToken> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actorUserId,
      permissionKey: KDS_DEVICE_ADMIN_PERMISSION_KEY,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    if (!UUID_RE.test(input.branchId)) throw new ValidationError('A device token requires a valid branch id', 'branchId');
    if (input.label.length > MAX_LABEL_LENGTH) throw new ValidationError('A device token label is at most 200 characters', 'label');
    const plaintextToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(plaintextToken);
    const record = await this.dependencies.store.run(tenantId, (scope) =>
      scope.insertDeviceToken(tenantId, {
        branchId: input.branchId,
        tokenHash,
        label: input.label,
        createdBy: actorUserId,
      }),
    );
    return { record, plaintextToken };
  }

  /**
   * Instantly revokes a token by id. New connections presenting it are
   * rejected from this commit on; already-open WebSocket connections are
   * dropped by the realtime server (revokeConnectionsForTokenHash wiring +
   * periodic revalidation backstop).
   */
  async revokeDeviceToken(tenantId: string, actorUserId: string, tokenId: string): Promise<KdsDeviceTokenRecord> {
    await this.dependencies.authorization.check({
      tenantId,
      userId: actorUserId,
      permissionKey: KDS_DEVICE_ADMIN_PERMISSION_KEY,
      context: { hasResource: false, actorBranchId: null, isSensitivePermission: true },
    });
    if (!UUID_RE.test(tokenId)) throw new ValidationError('Unknown device token', 'tokenId');
    return this.dependencies.store.run(tenantId, async (scope) => {
      const existing = await scope.loadDeviceTokenById(tenantId, tokenId);
      if (existing === null) throw new NotFoundError(`KDS device token ${tokenId} not found`);
      if (existing.status === 'revoked') return existing;
      return scope.revokeDeviceToken(tenantId, tokenId);
    });
  }

  /**
   * Verifies a presented token for the URL's tenant+branch. Fail-closed:
   * ANY mismatch returns { verified: false } — never a reason, never a
   * throw on attacker-shaped input (malformed tokens simply miss).
   */
  async verifyDeviceToken(tenantId: string, branchId: string, plaintextToken: string): Promise<KdsDeviceVerification> {
    if (typeof plaintextToken !== 'string' || plaintextToken === '') return VERIFICATION_FAILED;
    const tokenHash = sha256Hex(plaintextToken);
    const record = await this.dependencies.store.run(tenantId, (scope) => scope.loadDeviceTokenByHash(tenantId, tokenHash));
    if (record === null) return VERIFICATION_FAILED;
    if (record.status !== 'active') return VERIFICATION_FAILED;
    if (record.branchId !== branchId) return VERIFICATION_FAILED;
    await this.dependencies.store.run(tenantId, (scope) => scope.touchDeviceTokenLastUsed(tenantId, record.id));
    return { verified: true, tokenId: record.id, tokenHash: record.tokenHash };
  }

  /**
   * Revalidation probe for OPEN subscriptions (the server's backstop): is
   * this token hash still an ACTIVE credential of this tenant? No branch
   * check — the branch is pinned at subscribe time and the row's branch can
   * never change (no mutation moves it). Like verify(), this IS auth
   * infrastructure: no actor, no permission check.
   */
  async isDeviceTokenActive(tenantId: string, tokenHash: string): Promise<boolean> {
    if (typeof tokenHash !== 'string' || tokenHash === '') return false;
    const record = await this.dependencies.store.run(tenantId, (scope) => scope.loadDeviceTokenByHash(tenantId, tokenHash));
    return record !== null && record.status === 'active';
  }
}
