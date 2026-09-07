/**
 * Dedicated, least-privilege DB path for the GLOBAL `auth_audit_log` table.
 *
 * ⚠️ THIS FILE IS THE ONE DELIBERATE, DOCUMENTED EXCEPTION to the project rule
 * "every DB access goes through withTenantContext() only". It is allowed to
 * import `pg` directly (see eslint-rules/pg-import-policy.ts allow-list +
 * test/unit/architecture/pg-import-policy.test.ts) for one reason:
 *
 *   Authentication attempts against a NON-EXISTENT tenant (or an unknown
 *   user/identifier) carry NO authenticated tenant context. withTenantContext()
 *   requires a valid tenant id, sets `app.current_tenant_id`, and runs every
 *   statement under RLS with `verifyTenantExists` (which itself refuses unknown
 *   tenants). A login attempt for a tenant that does not exist therefore has no
 *   RLS context to bind — yet those attempts MUST be audited and MUST count
 *   toward rate limiting. `auth_audit_log` is consequently a GLOBAL table with
 *   no `tenant_id` column / no tenant_isolation policy (it carries
 *   `tenant_id_attempted`, nullable, no FK — the value the caller CLAIMED),
 *   exactly like the global `tenants` and `permissions_registry` tables. See
 *   migration 0005 header and docs/backlog.md ("auth_audit_log exception").
 *
 * Least-privilege containment:
 *   - The connection uses the dedicated `app_audit` login role
 *     (migrations/roles/003_app_audit.sql), provisioned with a separate
 *     AUDIT_DATABASE_URL secret. That role is NOBYPASSRLS and is granted
 *     EXECUTE on ONLY two SECURITY DEFINER functions:
 *       record_auth_attempt(...)      — append a row
 *       count_recent_auth_failures(...) — sliding-window failure counter
 *     It has NO direct SELECT/INSERT on auth_audit_log and NO privilege on any
 *     tenant-scoped table. No dynamic SQL exists anywhere on this path.
 *
 * Nothing else in the codebase should call this module; it is consumed only by
 * the authentication composition root.
 */
import pg from 'pg';

import { ConfigurationError } from '../../shared/errors.ts';

export const AUDIT_DATABASE_URL_KEY = 'AUDIT_DATABASE_URL';

export interface AuditEnvironment {
  readonly [AUDIT_DATABASE_URL_KEY]?: string | undefined;
}

/**
 * Resolves the dedicated audit-role connection string. Fails closed
 * (ConfigurationError) when missing/empty or not a postgres(s) URL — the
 * security layer must never silently run without audit storage.
 */
export function resolveAuditDatabaseUrl(env: AuditEnvironment): string {
  const raw = env[AUDIT_DATABASE_URL_KEY];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigurationError(
      `${AUDIT_DATABASE_URL_KEY} is not set; the authentication audit log requires a dedicated least-privilege connection.`,
      AUDIT_DATABASE_URL_KEY,
    );
  }
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError(`${AUDIT_DATABASE_URL_KEY} is not a valid database URL.`, AUDIT_DATABASE_URL_KEY);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new ConfigurationError(
      `${AUDIT_DATABASE_URL_KEY} must use the postgres:// or postgresql:// protocol.`,
      AUDIT_DATABASE_URL_KEY,
    );
  }
  if (parsed.hostname === '') {
    throw new ConfigurationError(`${AUDIT_DATABASE_URL_KEY} must include a host name.`, AUDIT_DATABASE_URL_KEY);
  }
  return url;
}

/** Structural shape of a pool this module needs (pg.Pool satisfies it). */
export interface AuditPool {
  connect(): Promise<{
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<pg.QueryResult<R>>;
    release(err?: Error | boolean): void;
  }>;
  end(): Promise<void>;
}

/** Creates the dedicated audit pool. Factored out for test injection. */
export function createAuditPool(connectionString: string): AuditPool {
  return new pg.Pool({
    connectionString,
    // Small, separate pool: audit writes are tiny and must not contend with
    // the tenant pool.
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export type AuthAuditMode = 'password' | 'pin' | 'refresh';

export interface RecordAuthAttemptParams {
  /** What the client claimed as the tenant; null for malformed/missing. */
  readonly tenantIdAttempted: string | null;
  /** What the client claimed as the user id/staff code; null when absent. */
  readonly userIdAttempted: string | null;
  /**
   * The targeted account identifier — the lower-cased email / staff code /
   * token subject — used by the per-account rate limiter. NEVER a secret
   * (never a password/PIN/token): a free-form key only.
   */
  readonly identifierAttempted: string;
  readonly mode: AuthAuditMode;
  readonly success: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface RateLimitWindow {
  /** Sliding window length, milliseconds. */
  readonly windowMs: number;
}

export interface CountFailuresParams extends RateLimitWindow {
  readonly mode: AuthAuditMode;
  readonly ipAddress: string | null;
  readonly identifierAttempted: string;
}

/**
 * The audit sink port consumed by the auth engine. Production implementation
 * below talks ONLY to the SECURITY DEFINER functions via the audit role.
 */
export interface AuthAuditSink {
  recordAttempt(params: RecordAuthAttemptParams): Promise<void>;
  countRecentFailures(params: CountFailuresParams): Promise<number>;
}

/**
 * Production AuthAuditSink — the single implementation allowed to touch the
 * audit table, through the app_audit role's two functions only.
 */
export class PostgresAuthAuditSink implements AuthAuditSink {
  private readonly pool: AuditPool;

  constructor(pool: AuditPool) {
    this.pool = pool;
  }

  async recordAttempt(params: RecordAuthAttemptParams): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'SELECT record_auth_attempt($1::uuid, $2, $3, $4, $5, $6, $7)',
        [
          params.tenantIdAttempted,
          params.userIdAttempted,
          params.identifierAttempted,
          params.mode,
          params.success,
          params.ipAddress,
          params.userAgent,
        ],
      );
    } finally {
      client.release();
    }
  }

  async countRecentFailures(params: CountFailuresParams): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ count_recent_auth_failures: number }>(
        'SELECT count_recent_auth_failures($1, $2, $3, $4) AS count_recent_auth_failures',
        [params.mode, params.ipAddress, params.identifierAttempted, params.windowMs],
      );
      return result.rows[0]?.count_recent_auth_failures ?? 0;
    } finally {
      client.release();
    }
  }
}
