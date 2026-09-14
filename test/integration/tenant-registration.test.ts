import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresPermissionWriteRepository,
  type PostgresPermissionRepositoryDependencies,
} from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { ValidationError } from '../../src/shared/errors.ts';
import { testDatabaseUrl } from '../support/database.ts';

describe('integration: self-service tenant registration', () => {
  let ownerPool: pg.Pool;
  let appPool: pg.Pool;
  let withApp: WithTenantContext;
  let write: PostgresPermissionWriteRepository;
  const inactiveCountryCode = 'ZZ';

  beforeAll(async () => {
    ownerPool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 });
    for (const file of ['001_app_login.sql', '002_app_login_rbac.sql', '016_tenant_tax_write.sql']) {
      await ownerPool.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }
    const appPassword = randomBytes(24).toString('hex');
    await ownerPool.query(
      `ALTER ROLE app_login LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = appPassword;
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 3 });
    withApp = createWithTenantContext(appPool, { verifyTenantExists: true });
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
      await appPool?.end();
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
    expect(granted.rows.map((row) => row.permission_key)).toEqual(expect.arrayContaining([
      'tax_rate:create',
      'tax_rate:close_and_supersede',
      'tax:configure',
    ]));
  });

  it('lets the registered tenant owner create a tenant tax rate through app_login', async () => {
    const { tenantId, branchId } = registrationIds();
    await write.registerTenantWithCountry(
      tenantId, 'Tenant tax owner', 'EG', branchId, 'Owner branch', 'Africa/Cairo',
    );

    const role = await ownerPool.query<{ id: string }>(
      `SELECT id FROM roles
        WHERE tenant_id = $1 AND name = 'TENANT_SUPER_ADMIN' AND is_system = true`,
      [tenantId],
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) throw new Error('tenant registration did not create its system role');

    const userId = randomUUID();
    await withApp(tenantId, async (q) => {
      await q.query(
        `INSERT INTO users (id, tenant_id, email, password_hash)
         VALUES ($1, $2, $3, 'test-only-password-hash')`,
        [userId, tenantId, `${userId}@example.test`],
      );
      await q.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, $3, 'tenant', NULL)`,
        [tenantId, userId, roleId],
      );
    });

    const granted = await withApp(tenantId, (q) => q.query<{ permission_key: string }>(
      `SELECT permission_key FROM role_permissions
        WHERE tenant_id = $1 AND role_id = $2
          AND permission_key = ANY($3::text[])
        ORDER BY permission_key`,
      [tenantId, roleId, ['tax_rate:create', 'tax_rate:close_and_supersede', 'tax:configure']],
    ));
    expect(granted.rows.map((row) => row.permission_key)).toEqual([
      'tax:configure',
      'tax_rate:close_and_supersede',
      'tax_rate:create',
    ]);

    const category = await withApp(tenantId, (q) => q.query<{ id: string }>(
      `INSERT INTO tenant_tax_categories (tenant_id, country_code, code, kind, tax_family, name)
       VALUES ($1, 'EG', $2, 'standard', 'vat', '{"en":"Owner tax"}')
       RETURNING id`,
      [tenantId, `owner-tax-${randomUUID()}`],
    ));
    const categoryId = category.rows[0]?.id;
    if (categoryId === undefined) throw new Error('tenant tax category insert returned no row');

    const rate = await withApp(tenantId, (q) => q.query<{ tenant_id: string; rate_bps: number }>(
      `SELECT tenant_id, rate_bps
         FROM create_tenant_tax_rate($1, $2, 725, false, '2027-01-01'::date, NULL)`,
      [tenantId, categoryId],
    ));
    expect(rate.rows[0]).toEqual({ tenant_id: tenantId, rate_bps: 725 });
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
