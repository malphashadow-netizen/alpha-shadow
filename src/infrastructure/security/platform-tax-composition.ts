/** Only the isolated platform-admin service imports this composition root. */
import { PlatformTaxAdminEngine } from '../../application/engines/tax/platform-tax-admin-engine.ts';
import { createPool, resolvePoolOptions } from '../db/pool.ts';
import { createWithPlatformTaxContext, resolvePlatformTaxDatabaseUrl, type PlatformTaxEnvironment } from '../db/platform-tax-context.ts';
import { PostgresPlatformTaxAdminRepository } from '../db/repositories/postgres-platform-tax-admin-repository.ts';

export interface PlatformTaxRuntime {
  readonly engine: PlatformTaxAdminEngine;
  close(): Promise<void>;
}
export function createPlatformTaxRuntime(env: PlatformTaxEnvironment): PlatformTaxRuntime {
  const connectionString = resolvePlatformTaxDatabaseUrl(env);
  const pool = createPool(resolvePoolOptions({ ...env, DATABASE_URL: connectionString }, { max: 2 }));
  return { engine: new PlatformTaxAdminEngine(new PostgresPlatformTaxAdminRepository(createWithPlatformTaxContext(pool))),
    close: () => pool.end() };
}
