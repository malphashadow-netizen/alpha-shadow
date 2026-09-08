/**
 * Isolated PLATFORM capability, never withTenantContext and never the app
 * pool. No raw pg import: the sanctioned pool factory owns driver creation.
 * Database privileges, not a tenant role-name comparison, gate every call.
 */
import { ConfigurationError, ConflictError, ForbiddenError, ValidationError } from '../../shared/errors.ts';
import type { TenantPool, TenantQuery } from './tenant-context.ts';
import { mapPostgresError } from './postgres-errors.ts';

export const PLATFORM_TAX_DATABASE_URL_KEY = 'PLATFORM_TAX_DATABASE_URL';
export interface PlatformTaxEnvironment {
  readonly PLATFORM_TAX_DATABASE_URL?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly MIGRATION_DATABASE_URL?: string | undefined;
  readonly AUDIT_DATABASE_URL?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}
function parseUrl(raw: string): URL {
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname === '' || url.username === '') throw new Error('invalid');
    return url;
  } catch {
    throw new ConfigurationError('PLATFORM_TAX_DATABASE_URL must be a valid dedicated PostgreSQL connection URL', PLATFORM_TAX_DATABASE_URL_KEY);
  }
}
export function resolvePlatformTaxDatabaseUrl(env: PlatformTaxEnvironment): string {
  const raw = env.PLATFORM_TAX_DATABASE_URL?.trim();
  if (raw === undefined || raw === '') throw new ConfigurationError('PLATFORM_TAX_DATABASE_URL is required for platform tax administration', PLATFORM_TAX_DATABASE_URL_KEY);
  const url = parseUrl(raw);
  for (const other of [env.DATABASE_URL, env.MIGRATION_DATABASE_URL, env.AUDIT_DATABASE_URL]) {
    if (other === undefined || other.trim() === '') continue;
    const candidate = parseUrl(other);
    if (url.hostname === candidate.hostname && (url.port || '5432') === (candidate.port || '5432') && url.username === candidate.username) {
      throw new ConfigurationError('Platform tax administration must not reuse the app, audit or migration database principal', PLATFORM_TAX_DATABASE_URL_KEY);
    }
  }
  return raw;
}
export type WithPlatformTaxContext = <T>(actorId: string, fn: (q: TenantQuery) => Promise<T>) => Promise<T>;

export function createWithPlatformTaxContext(pool: TenantPool): WithPlatformTaxContext {
  return async <T>(actorId: string, fn: (q: TenantQuery) => Promise<T>): Promise<T> => {
    if (!/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(actorId)) {
      throw new ValidationError('A valid platform actor UUID is required', 'actorId');
    }
    const client = await pool.connect();
    let result: T | undefined;
    const errors: unknown[] = [];
    let begun = false;
    try {
      await client.query('BEGIN');
      begun = true;
      await client.query("SELECT set_config('statement_timeout', '30000', true)");
      const check = await client.query<{ permitted: boolean; tenant_context: string | null }>(
        `SELECT COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = 'platform_tax_admin'), 'USAGE'), false)
           AND NOT rolsuper AND NOT rolbypassrls AS permitted,
           NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant_context
         FROM pg_roles WHERE rolname = current_user`);
      if (check.rows[0]?.permitted !== true || check.rows[0].tenant_context !== null) {
        throw new ForbiddenError('A dedicated platform tax database capability without tenant context is required');
      }
      // Also supports dedicated logins inheriting the capability. This is an
      // SQL privilege boundary, not RBAC authorization by a role name in code.
      await client.query('SET LOCAL ROLE platform_tax_admin');
      await client.query("SELECT set_config('app.platform_tax_actor_id', $1, true)", [actorId]);
      let active = true;
      const query = Object.freeze<TenantQuery>({ query: (text, values) => {
        if (!active) throw new ConflictError('Platform tax transaction scope has ended');
        return client.query(text, values);
      } });
      try { result = await fn(query); } finally { active = false; }
      await client.query('COMMIT');
      begun = false;
    } catch (error) {
      errors.push(error);
      if (begun) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { errors.push(rollbackError); }
      }
    }
    try {
      await client.query('DISCARD ALL');
      client.release(errors.length > 1 ? true : undefined);
    } catch (discardError) {
      errors.push(discardError);
      client.release(true);
    }
    // B3: concurrency-control deaths (40001/40P01/55P03) surface as the
    // retryable domain error; everything else passes through untouched.
    if (errors.length === 1) throw mapPostgresError(errors[0]);
    if (errors.length > 1) throw new AggregateError(errors, 'Platform tax transaction/cleanup failed');
    return result as T;
  };
}
