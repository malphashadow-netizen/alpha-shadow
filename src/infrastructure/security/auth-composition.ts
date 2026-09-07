/**
 * Authentication composition root — builds the production auth engine from
 * the environment, fail-closed.
 *
 * Boot posture: every secret is required and validated BEFORE the engine can
 * serve a request. A missing/invalid PIN_HASH_PEPPER, a missing/invalid JWT
 * key, or a missing/invalid AUDIT_DATABASE_URL throws ServiceUnavailableError
 * (→ 503) at composition time — the process never runs a half-configured
 * security layer. Secret values are never echoed (variable names only).
 *
 * The returned bundle exposes the framework-agnostic request handlers used by
 * the presentation layer (see src/presentation/routes/auth).
 */
import { withTenantContext } from '../db/tenant-context.ts';
import {
  createAuditPool,
  PostgresAuthAuditSink,
  resolveAuditDatabaseUrl,
  type AuditEnvironment,
} from '../db/auth-audit.ts';
import { LoginEngine } from '../../application/engines/auth/login-engine.ts';
import { RefreshEngine } from '../../application/engines/auth/refresh-engine.ts';
import { JwtTokenService, DEFAULT_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_REFRESH_TOKEN_TTL_SECONDS } from '../../shared/auth/token-service.ts';
import { HmacPinHasher, ScryptPasswordHasher } from '../../shared/auth/hashers.ts';
import type { LoginContext, LoginOutcome } from '../../application/engines/auth/login-engine.ts';
import type { RefreshSuccess } from '../../application/engines/auth/refresh-engine.ts';
import type { LoginRequest, RefreshRequest } from '../../application/engines/auth/request-schema.ts';
import { PostgresAuthRepository, PostgresRefreshTokenStore } from './postgres-auth-repository.ts';
import { loadAuthSecrets, type AuthSecretEnvironment } from './auth-config.ts';

export interface AuthEnvironment extends AuthSecretEnvironment, AuditEnvironment {
  readonly NODE_ENV?: string | undefined;
}

export interface AuthEngine {
  login(request: LoginRequest, context: LoginContext): Promise<LoginOutcome>;
  refresh(request: RefreshRequest, context: LoginContext): Promise<RefreshSuccess>;
}

export interface AuthComposition extends AuthEngine {
  /** Closes the dedicated audit pool (test/shutdown convenience). */
  close(): Promise<void>;
}

/**
 * Builds the production auth engine. Throws ServiceUnavailableError (→503)
 * when any required secret/connection is missing or malformed.
 */
export function composeAuthEngine(env: AuthEnvironment = process.env): AuthComposition {
  // Secrets first — a missing pepper/key fails boot before any pool is opened.
  const secrets = loadAuthSecrets(env);

  // Dedicated least-privilege audit connection (the one non-tenant-context DB
  // path — see src/infrastructure/db/auth-audit.ts).
  const auditUrl = resolveAuditDatabaseUrl(env);
  const auditPool = createAuditPool(auditUrl);
  const auditSink = new PostgresAuthAuditSink(auditPool);

  // Tenant-scoped adapters over the standard withTenantContext path.
  const authRepository = new PostgresAuthRepository({ withTenantContext });
  const refreshTokenStore = new PostgresRefreshTokenStore({ withTenantContext });

  const tokenService = new JwtTokenService({
    privateKey: secrets.jwtPrivateKey,
    publicKey: secrets.jwtPublicKey,
    algorithm: secrets.jwtAlgorithm,
  });

  const passwordHasher = new ScryptPasswordHasher();
  const pinHasher = new HmacPinHasher(secrets.pinPepper);

  const refreshTtlSeconds = DEFAULT_REFRESH_TOKEN_TTL_SECONDS;

  const loginEngine = new LoginEngine({
    authRepository,
    refreshTokenStore,
    auditSink,
    tokenService,
    passwordHasher,
    pinHasher,
    refreshTtlSeconds,
  });

  const refreshEngine = new RefreshEngine({
    authRepository,
    refreshTokenStore,
    auditSink,
    tokenService,
    refreshTtlSeconds,
  });

  return Object.freeze({
    login: (request: LoginRequest, context: LoginContext) => loginEngine.login(request, context),
    refresh: (request: RefreshRequest, context: LoginContext) => refreshEngine.refresh(request, context),
    close: async () => {
      await auditPool.end();
    },
  });
}

export { DEFAULT_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_REFRESH_TOKEN_TTL_SECONDS };
