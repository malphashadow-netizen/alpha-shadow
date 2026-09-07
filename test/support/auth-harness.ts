/**
 * Integration-test harness for the auth layer against the REAL PostgreSQL
 * provisioned by postgres.global-setup.ts.
 *
 * It builds the production-shaped wiring (PostgresAuthRepository,
 * PostgresRefreshTokenStore, JWT token service, scrypt/HMAC hashers, the
 * audit sink over a dedicated pool) but with TEST-ONLY settings:
 *   - the audit sink uses the SAME owner connection the harness uses (the
 *     least-privilege `app_audit` role is a manual DBA action; in the test
 *     cluster the owner connection is permitted to EXECUTE the SECURITY
 *     DEFINER functions directly),
 *   - fast scrypt parameters and small rate-limit/lock thresholds so the
 *     concurrency and timing assertions run quickly.
 *
 * Credentials/keys are GENERATED AT RUNTIME — no plaintext in the tree.
 */
import pg from 'pg';

import { LoginEngine } from '../../src/application/engines/auth/login-engine.ts';
import { RefreshEngine } from '../../src/application/engines/auth/refresh-engine.ts';
import { JwtTokenService } from '../../src/shared/auth/token-service.ts';
import { ScryptPasswordHasher, HmacPinHasher } from '../../src/shared/auth/hashers.ts';
import { decodePinPepper } from '../../src/shared/auth/pin.ts';
import { loadPrivateKey, loadPublicKey } from '../../src/shared/auth/jwt.ts';
import { PostgresAuthRepository, PostgresRefreshTokenStore } from '../../src/infrastructure/security/postgres-auth-repository.ts';
import { PostgresAuthAuditSink, createAuditPool, type AuditPool } from '../../src/infrastructure/db/auth-audit.ts';
import { createWithTenantContext, type TenantPool } from '../../src/infrastructure/db/tenant-context.ts';
import { testDatabaseUrl } from './database.ts';
import { generatePepper, generateRsaKeypair } from './auth-secrets.ts';

// Fast scrypt parameters for the integration suite only.
const FAST_SCRYPT = { N: 16, r: 8, p: 1 } as const;

export interface Harness {
  pool: pg.Pool;
  auditPool: AuditPool;
  login: LoginEngine;
  refresh: RefreshEngine;
  passwordHasher: ScryptPasswordHasher;
  pinHasher: HmacPinHasher;
  client: pg.Client;
  close(): Promise<void>;
}

export interface HarnessOptions {
  passwordThreshold?: number;
  pinThreshold?: number;
  ipRateLimit?: number;
  accountRateLimit?: number;
}

export async function buildAuthHarness(options: HarnessOptions = {}): Promise<Harness> {
  const url = testDatabaseUrl();
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // The audit sink's dedicated pool also points at the owner-role test
  // database; it can EXECUTE the SECURITY DEFINER functions the same way the
  // least-privilege app_audit role will in production (least-privilege of the
  // ROLE is separately verified by the contract suite).
  const auditPool: AuditPool = createAuditPool(url);
  const auditSink = new PostgresAuthAuditSink(auditPool);

  const keys = generateRsaKeypair();
  const tokenService = new JwtTokenService({
    privateKey: loadPrivateKey(keys.privateKeyPem),
    publicKey: loadPublicKey(keys.publicKeyPem),
    algorithm: 'RS256',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86_400,
  });

  const passwordHasher = new ScryptPasswordHasher(FAST_SCRYPT);
  const pinHasher = new HmacPinHasher(decodePinPepper(generatePepper(32)));

  // Build a withTenantContext backed by the TEST pool so RLS still applies
  // (verifyTenantExists disabled: the harness seeds tenants directly).
  const tenantPool: TenantPool = {
    connect: async () => pool.connect(),
  };
  const withTenantContext = createWithTenantContext(tenantPool, { verifyTenantExists: false });

  const authRepository = new PostgresAuthRepository({ withTenantContext });
  const refreshTokenStore = new PostgresRefreshTokenStore({ withTenantContext });

  const login = new LoginEngine({
    authRepository,
    refreshTokenStore,
    auditSink,
    tokenService,
    passwordHasher,
    pinHasher,
    refreshTtlSeconds: 86_400,
    passwordThreshold: options.passwordThreshold ?? 5,
    pinThreshold: options.pinThreshold ?? 3,
    ipRateLimit: options.ipRateLimit ?? 20,
    accountRateLimit: options.accountRateLimit ?? 10,
  });

  const refresh = new RefreshEngine({
    authRepository,
    refreshTokenStore,
    auditSink,
    tokenService,
    refreshTtlSeconds: 86_400,
    ipRateLimit: options.ipRateLimit ?? 20,
    accountRateLimit: options.accountRateLimit ?? 10,
  });

  return {
    pool,
    auditPool,
    login,
    refresh,
    passwordHasher,
    pinHasher,
    client,
    close: async () => {
      await client.end();
      await pool.end();
      await auditPool.end();
    },
  };
}

/**
 * Inserts a test tenant + user directly via the owner connection (seed
 * data is test-only and allowed outside withTenantContext). Returns the
 * generated credential values (runtime random) so the test can log in.
 */
export async function seedUser(
  client: pg.Client,
  params: {
    tenantId: string;
    userId?: string;
    email?: string;
    staffCode?: string;
    password?: string;
    pin?: string;
    passwordHash?: string | null;
    pinHash?: string | null;
    isActive?: boolean;
    passwordHasher?: ScryptPasswordHasher;
    pinHasher?: HmacPinHasher;
  },
): Promise<{ userId: string; email: string; staffCode: string | null; password: string | null; pin: string | null }> {
  const userId = params.userId ?? crypto.randomUUID();
  const email = params.email ?? `${userId}@test.local`;
  let passwordHash = params.passwordHash ?? null;
  let pinHash = params.pinHash ?? null;

  await client.query(`INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active') ON CONFLICT (id) DO NOTHING`, [
    params.tenantId,
    `tenant-${params.tenantId}`,
  ]);

  // Generate hashes from runtime credentials unless pre-supplied.
  if (params.password !== undefined && passwordHash === null) {
    if (params.passwordHasher === undefined) throw new Error('passwordHasher required to hash a seeded password');
    passwordHash = await params.passwordHasher.hash(params.password);
  }
  if (params.pin !== undefined && pinHash === null) {
    if (params.pinHasher === undefined) throw new Error('pinHasher required to hash a seeded pin');
    pinHash = params.pinHasher.hash(params.tenantId, userId, params.pin);
  }

  await client.query(
    `INSERT INTO users (id, tenant_id, email, staff_code, password_hash, pin_hash, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, staff_code = EXCLUDED.staff_code,
           password_hash = EXCLUDED.password_hash, pin_hash = EXCLUDED.pin_hash,
           is_active = EXCLUDED.is_active`,
    [userId, params.tenantId, email, params.staffCode ?? null, passwordHash, pinHash, params.isActive ?? true],
  );

  return { userId, email, staffCode: params.staffCode ?? null, password: params.password ?? null, pin: params.pin ?? null };
}

/** Returns fresh user + login password/pin (runtime generated). */
export async function seedRandomUser(
  client: pg.Client,
  h: Pick<Harness, 'passwordHasher' | 'pinHasher'>,
  params: {
    tenantId: string;
    userId?: string;
    mode: 'password' | 'pin' | 'both';
    staffCode?: string;
    isActive?: boolean;
  },
): Promise<{ userId: string; email: string; staffCode: string | null; password: string | null; pin: string | null }> {
  const { generatePassword, generatePin } = await import('./auth-secrets.ts');
  const userId = params.userId ?? crypto.randomUUID();
  const password = params.mode !== 'pin' ? generatePassword() : undefined;
  const pin = params.mode !== 'password' ? generatePin(4) : undefined;
  return seedUser(client, {
    tenantId: params.tenantId,
    userId,
    ...(params.staffCode !== undefined ? { staffCode: params.staffCode } : {}),
    isActive: params.isActive ?? true,
    ...(password !== undefined ? { password } : {}),
    ...(pin !== undefined ? { pin } : {}),
    passwordHasher: h.passwordHasher,
    pinHasher: h.pinHasher,
  });
}
