/**
 * In-memory fakes for the auth ports — unit tests only. They let the login
 * and refresh engines be exercised without a database while preserving the
 * real scrypt/HMAC/JWT primitives. No secret literals appear here: callers
 * generate credentials at runtime via auth-secrets.ts.
 */
import { decodePinPepper } from '../../src/shared/auth/pin.ts';
import { hashPassword } from '../../src/shared/auth/password.ts';
import { HmacPinHasher, ScryptPasswordHasher } from '../../src/shared/auth/hashers.ts';
import { JwtTokenService } from '../../src/shared/auth/token-service.ts';
import type {
  AuthUserRecord,
  IAuthAuditSink,
  IAuthRepository,
  IRefreshTokenStore,
  RefreshRotation,
  SecVInputs,
} from '../../src/domain/contracts/auth.ts';
import { loadPrivateKey, loadPublicKey } from '../../src/shared/auth/jwt.ts';
import { generatePepper, generateRsaKeypair } from './auth-secrets.ts';

// Fast scrypt parameters for tests.
const FAST_SCRYPT = { N: 16, r: 8, p: 1 } as const;

export interface FakeUser {
  id: string;
  tenantId: string;
  email: string;
  staffCode: string | null;
  passwordHash: string | null;
  pinHash: string | null;
  isActive: boolean;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  securityVersion: number;
  activeRoles: SecVInputs['activeRoles'];
}

export class FakeAuthRepository implements IAuthRepository {
  readonly users = new Map<string, FakeUser>();
  failedAttemptRegistrations: number[] = [];

  key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  addUser(user: FakeUser): void {
    this.users.set(this.key(user.tenantId, user.id), user);
  }

  async findByEmail(tenantId: string, email: string): Promise<AuthUserRecord | null> {
    const normalized = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.tenantId === tenantId && user.email.trim().toLowerCase() === normalized) {
        return this.toRecord(user);
      }
    }
    return null;
  }

  async findByPinIdentifier(tenantId: string, identifier: string): Promise<AuthUserRecord | null> {
    const isUuid = /^[0-9a-f-]{36}$/i.test(identifier);
    for (const user of this.users.values()) {
      if (user.tenantId !== tenantId) continue;
      if (isUuid && user.id === identifier) return this.toRecord(user);
      if (user.staffCode !== null && user.staffCode.toLowerCase() === identifier.toLowerCase()) {
        return this.toRecord(user);
      }
    }
    return null;
  }

  async registerFailedAttempt(params: {
    tenantId: string;
    userId: string;
    limit: number;
    lockWindowMs: number;
  }): Promise<{ failedLoginAttempts: number; lockedUntil: Date | null; nowLocked: boolean }> {
    const user = this.users.get(this.key(params.tenantId, params.userId));
    if (user === undefined) return { failedLoginAttempts: 0, lockedUntil: null, nowLocked: false };
    const wasLocked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
    user.failedLoginAttempts += 1;
    this.failedAttemptRegistrations.push(user.failedLoginAttempts);
    let nowLocked = false;
    if (user.failedLoginAttempts >= params.limit && !wasLocked) {
      user.lockedUntil = new Date(Date.now() + params.lockWindowMs);
      nowLocked = true;
    }
    return { failedLoginAttempts: user.failedLoginAttempts, lockedUntil: user.lockedUntil, nowLocked };
  }

  async registerSuccessfulLogin(tenantId: string, userId: string) {
    const user = this.users.get(this.key(tenantId, userId));
    if (user === undefined) throw new Error('no user');
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    return { userId: user.id, securityVersion: user.securityVersion, activeRoles: user.activeRoles };
  }

  async getActiveSecVInputs(tenantId: string, userId: string) {
    const user = this.users.get(this.key(tenantId, userId));
    if (user === undefined) return null;
    return { userId: user.id, isActive: user.isActive, securityVersion: user.securityVersion, activeRoles: user.activeRoles };
  }

  private toRecord(user: FakeUser): AuthUserRecord {
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      staffCode: user.staffCode,
      passwordHash: user.passwordHash,
      pinHash: user.pinHash,
      isActive: user.isActive,
      lockedUntil: user.lockedUntil,
    };
  }
}

export interface FakeRefreshRow {
  tenantId: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class FakeRefreshTokenStore implements IRefreshTokenStore {
  readonly rows: FakeRefreshRow[] = [];

  async store(params: { tenantId: string; userId: string; tokenHash: string; familyId: string; expiresAt: Date }): Promise<void> {
    this.rows.push({ ...params, revokedAt: null });
  }

  async rotate(params: {
    tenantId: string;
    oldTokenHash: string;
    newTokenHash: string;
    familyId: string;
    newExpiresAt: Date;
    now: Date;
  }): Promise<RefreshRotation> {
    const row = this.rows.find((r) => r.tenantId === params.tenantId && r.tokenHash === params.oldTokenHash);
    if (row === undefined) return { status: 'invalid' };
    if (row.revokedAt !== null) {
      for (const r of this.rows) {
        if (r.tenantId === params.tenantId && r.familyId === row.familyId && r.revokedAt === null) {
          r.revokedAt = params.now;
        }
      }
      return { status: 'replayed' };
    }
    const user = this.fakeUserLookup?.(params.tenantId, row.userId);
    if (user !== undefined && user !== null) {
      const locked = user.lockedUntil !== null && user.lockedUntil > params.now;
      if (!user.isActive || locked) return { status: 'account_blocked' };
    }
    row.revokedAt = params.now;
    this.rows.push({
      tenantId: row.tenantId,
      userId: row.userId,
      tokenHash: params.newTokenHash,
      familyId: params.familyId,
      expiresAt: params.newExpiresAt,
      revokedAt: null,
    });
    return { status: 'rotated', userId: row.userId, tenantId: row.tenantId };
  }

  fakeUserLookup: ((tenantId: string, userId: string) => FakeUser | undefined) | null = null;
}

export class FakeAuditSink implements IAuthAuditSink {
  readonly attempts: { identifierAttempted: string; mode: string; success: boolean; ipAddress: string | null }[] = [];
  failureCount = 0;

  async recordAttempt(params: {
    tenantIdAttempted: string | null;
    userIdAttempted: string | null;
    identifierAttempted: string;
    mode: 'password' | 'pin' | 'refresh';
    success: boolean;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<void> {
    this.attempts.push(params);
    if (!params.success) this.failureCount += 1;
  }

  async countRecentFailures(params: {
    mode: string;
    ipAddress: string | null;
    identifierAttempted: string;
    windowMs: number;
  }): Promise<number> {
    return this.attempts.filter(
      (a) => !a.success && (a.ipAddress === params.ipAddress || a.identifierAttempted === params.identifierAttempted),
    ).length;
  }
}

/** Builds a full set of fakes + real crypto helpers for engine tests. */
export async function buildAuthFakes() {
  const repo = new FakeAuthRepository();
  const refreshStore = new FakeRefreshTokenStore();
  const audit = new FakeAuditSink();
  refreshStore.fakeUserLookup = (tenantId, userId) => repo.users.get(repo.key(tenantId, userId));

  const pepper = decodePinPepper(generatePepper(32));
  const passwordHasher = new ScryptPasswordHasher(FAST_SCRYPT);
  const pinHasher = new HmacPinHasher(pepper);

  const keys = generateRsaKeypair();
  const tokenService = new JwtTokenService({
    privateKey: loadPrivateKey(keys.privateKeyPem),
    publicKey: loadPublicKey(keys.publicKeyPem),
    algorithm: 'RS256',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
  });

  const hashPasswordValue = (plain: string): Promise<string> => hashPassword(plain, FAST_SCRYPT);
  const hashPinValue = (tenantId: string, userId: string, pin: string): string =>
    pinHasher.hash(tenantId, userId, pin);

  return {
    repo,
    refreshStore,
    audit,
    passwordHasher,
    pinHasher,
    tokenService,
    refreshTtlSeconds: 3600,
    hashPasswordValue,
    hashPinValue,
  };
}
