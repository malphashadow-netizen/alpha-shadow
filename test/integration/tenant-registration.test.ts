import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresPermissionWriteRepository,
  type PostgresPermissionRepositoryDependencies,
} from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { createWithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { ValidationError } from '../../src/shared/errors.ts';
import { testDatabaseUrl } from '../support/database.ts';

describe('integration: self-service tenant registration', () => {
  let ownerPool: pg.Pool;
  let write: PostgresPermissionWriteRepository;
  const inactiveCountryCode = 'ZZ';

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });
    const dependencies: PostgresPermissionRepositoryDependencies = {
      withTenantContext: createWithTenantContext(ownerPool),
    };
    write = new PostgresPermissionWriteRepository(dependencies);
    await ownerPool.query(
      `INSERT INTO tax_jurisdictions (country_code, name, default_currency_code, is_active)
       VALUES ($1, '{"en":"Inactive test jurisdiction"}', 'EGP', false)
       ON CONFLICT (country_code) DO UPDATE SET is_active = false`,
      [inactiveCountryCode],
    );
  });

  afterAll(async () => {
    if (ownerPool !== undefined) {
      await ownerPool.query('DELETE FROM tax_jurisdictions WHERE country_code = $1', [inactiveCountryCode]);
      await ownerPool.end();
    }
  });

  function registrationIds(): { tenantId: string; branchId: string } {
    return { tenantId: randomUUID(), branchId: randomUUID() };
  }

  it('derives the Egyptian reporting and first-branch currency from the active jurisdiction', async () => {
    const { tenantId, branchId } = registrationIds();
    const egypt = await ownerPool.query<{ default_currency_code: string }>(
      `SELECT default_currency_code FROM tax_jurisdictions
        WHERE country_code = 'EG' AND is_active = true`,
    );
    const expectedCurrency = egypt.rows[0]?.default_currency_code;
    expect(expectedCurrency).toBeDefined();

    const result = await write.registerTenantWithCountry(
      tenantId, 'Egypt tenant', 'EG', branchId, 'Cairo branch', 'Africa/Cairo',
    );

    const tenant = await ownerPool.query<{ reporting_currency: string }>(
      'SELECT reporting_currency FROM tenants WHERE id = $1', [tenantId],
    );
    const branch = await ownerPool.query<{ country_code: string; base_currency: string }>(
      'SELECT country_code, base_currency FROM branches WHERE id = $1', [branchId],
    );
    expect(result.reportingCurrency).toBe(expectedCurrency);
    expect(tenant.rows[0]?.reporting_currency).toBe(expectedCurrency);
    expect(branch.rows[0]).toEqual({ country_code: 'EG', base_currency: expectedCurrency });
  });

  it('grants the system role every registered tenant permission without a financial cap', async () => {
    const { tenantId, branchId } = registrationIds();
    await write.registerTenantWithCountry(
      tenantId, 'Fully authorized tenant', 'EG', branchId, 'Authorized branch', 'Africa/Cairo',
    );

    const eligible = await ownerPool.query<{ key: string }>('SELECT key FROM permissions_registry ORDER BY key');
    const granted = await ownerPool.query<{ permission_key: string; max_amount_minor_units: string | null }>(
      `SELECT rp.permission_key, rp.max_amount_minor_units
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id AND r.tenant_id = rp.tenant_id
        WHERE rp.tenant_id = $1 AND r.name = $2 AND r.is_system = true
        ORDER BY rp.permission_key`,
      [tenantId, 'TENANT_SUPER_ADMIN'],
    );

    expect(granted.rows.map((row) => row.permission_key)).toEqual(eligible.rows.map((row) => row.key));
    expect(granted.rows).toHaveLength(eligible.rows.length);
    expect(granted.rows.every((row) => row.max_amount_minor_units === null)).toBe(true);
    expect(granted.rows.map((row) => row.permission_key)).not.toEqual(expect.arrayContaining([
      'tax_rate:create',
      'tax_rate:close_and_supersede',
      'tax:confirm_excise_override',
    ]));
  });

  it('rejects an unknown country without inserting a tenant', async () => {
    const { tenantId, branchId } = registrationIds();
    await expect(write.registerTenantWithCountry(
      tenantId, 'Unknown country', 'QQ', branchId, 'Unknown branch', 'UTC',
    )).rejects.toThrow(ValidationError);
    const tenant = await ownerPool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    expect(tenant.rows).toHaveLength(0);
  });

  it('rejects an inactive country and rolls back every registration row', async () => {
    const { tenantId, branchId } = registrationIds();
    await expect(write.registerTenantWithCountry(
      tenantId, 'Inactive country', inactiveCountryCode, branchId, 'Inactive branch', 'UTC',
    )).rejects.toThrow(ValidationError);
    const tenant = await ownerPool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    const branch = await ownerPool.query('SELECT id FROM branches WHERE id = $1', [branchId]);
    const roles = await ownerPool.query('SELECT id FROM roles WHERE tenant_id = $1', [tenantId]);
    expect(tenant.rows).toHaveLength(0);
    expect(branch.rows).toHaveLength(0);
    expect(roles.rows).toHaveLength(0);
  });

  it('rejects a duplicate tenant id without leaving additional registration rows', async () => {
    const { tenantId, branchId } = registrationIds();
    await write.registerTenantWithCountry(
      tenantId, 'Original tenant', 'EG', branchId, 'Original branch', 'Africa/Cairo',
    );

    await expect(write.registerTenantWithCountry(
      tenantId, 'Duplicate tenant', 'EG', randomUUID(), 'Duplicate branch', 'Africa/Cairo',
    )).rejects.toThrow();

    const tenant = await ownerPool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    const branches = await ownerPool.query('SELECT id FROM branches WHERE tenant_id = $1', [tenantId]);
    const roles = await ownerPool.query('SELECT id FROM roles WHERE tenant_id = $1 AND is_system = true', [tenantId]);
    expect(tenant.rows).toHaveLength(1);
    expect(branches.rows).toHaveLength(1);
    expect(roles.rows).toHaveLength(1);
  });
});
