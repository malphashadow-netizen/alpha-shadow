import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planMigrations, assertBackfillConfirmed, BRANCH_COUNTRY_CONTRACT_MIGRATION } from '../../../tools/lib/migration-plan.ts';

// Frozen at the requested base f4ee79980487ef530508fa88c18b27f12a84f94a.
const FROZEN = {
  "migrations/0001_phase1_tenant_isolation_probe.sql": "f8a56607f5d4dad43dc8a08c2df7ce0bf2f29a4636770f0a5345640dcf3a4ef6",
  "migrations/0002_tenants_registry.sql": "6f48caea6b09e564ebb629251ca979a299c662970d520210456a110d28a3e8cd",
  "migrations/0003_phase1_core_tables.sql": "88ff9fd3f514bb10ed1e2f486ce5888136b980855cd279bd7ae07a21ed3493c8",
  "migrations/0004_phase2_rbac_tables.sql": "2200006fdf60e615a3251bfff7df6cba7dfa3fc58668c150fa8c42b5481d88b1",
  "migrations/0005_phase3_auth.sql": "10553854a7e844a285749d61cfacbc68480efef9f77cb25ee5711fa82da34d56",
  "migrations/0006_phase4_multi_currency_audit.sql": "24f4b8a06f301e47860f109f5f64c23cc4c40c66322b4c3e25993a85d64ebfe7",
  "migrations/0007_seed_currencies.sql": "e19a6bab99f5f463210c8340efe657e365a804351db9a072422f48b77ac098f1",
  "migrations/0008_phase5_catalog.sql": "62b62c9d43e60b41a74871ecf5f45cb8564f7dc8954254272b7906e23770d5d0",
  "migrations/0009_phase5_modifier_single_max.sql": "45bb832e361575eac49211e2240e79742f01afef680a097be1a62b0813817f56",
  "src/application/engines/zatca/index.ts": "d155023e41aff22574987dc97d133abb3fca0f0053e1c15abd8364865753b349"
} as const;
const ROOT = new URL('../../../', import.meta.url);
describe('Phase 6 migration safety and architecture', () => {
  it.each(Object.entries(FROZEN))('%s is byte-for-byte unchanged from the approved base', (path, digest) => {
    expect(createHash('sha256').update(readFileSync(new URL(path, ROOT))).digest('hex')).toBe(digest);
  });
  it('supports explicit expand-only deployment and refuses unknown migration targets', () => {
    const files = ['0010_phase6_tax_jurisdictions.sql', '0012_phase6_branch_country.sql', BRANCH_COUNTRY_CONTRACT_MIGRATION];
    expect(planMigrations(files, { MIGRATION_THROUGH: '0012' })).toEqual(files.slice(0, 2));
    expect(planMigrations(files, {})).toEqual(files);
    expect(() => planMigrations(files, { MIGRATION_THROUGH: '9999' })).toThrow();
  });
  it('does not accept absent/false/nonliteral confirmation for the contract migration', () => {
    for (const value of [undefined, 'false', '1', 'yes', 'TRUE']) {
      expect(() => { assertBackfillConfirmed(BRANCH_COUNTRY_CONTRACT_MIGRATION, { PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED: value }); }).toThrow();
    }
    expect(() => { assertBackfillConfirmed(BRANCH_COUNTRY_CONTRACT_MIGRATION, { PHASE6_BRANCH_COUNTRY_BACKFILL_CONFIRMED: 'true' }); }).not.toThrow();
    expect(() => { assertBackfillConfirmed('0012_phase6_branch_country.sql', {}); }).not.toThrow();
  });
  it('tax engine has no country/channel/platform special-case literals and never imports ZATCA', () => {
    const directory = new URL('src/application/engines/tax/', ROOT);
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(file, directory), 'utf8');
      expect(source).not.toMatch(/['"](?:[A-Z]{2}|dine_in|takeaway|delivery_app|own_delivery|talabat|jahez)['"]/);
      expect(source).not.toMatch(/from\s+['"][^'"]*zatca/);
    }
  });
  it('expand migration does not infer or update branch countries, and contract is separate', () => {
    const expand = readFileSync(new URL('migrations/0012_phase6_branch_country.sql', ROOT), 'utf8');
    expect(expand).not.toMatch(/UPDATE\s+branches/i);
    expect(expand).not.toMatch(/SET\s+NOT\s+NULL/i);
    const contract = readFileSync(new URL(`migrations/${BRANCH_COUNTRY_CONTRACT_MIGRATION}`, ROOT), 'utf8');
    expect(contract).toContain('LOCK TABLE branches IN ACCESS EXCLUSIVE MODE');
    expect(contract).toContain('ALTER TABLE branches ALTER COLUMN country_code SET NOT NULL');
  });
  it('production seed requires platform-channel rules to be explicitly provisioned', () => {
    const sql = readFileSync(new URL('migrations/0011_phase6_delivery_and_channels.sql', ROOT), 'utf8');
    const liabilitySeed = sql.slice(sql.indexOf('INSERT INTO tax_liability_rules'));
    expect(liabilitySeed).toContain('NOT c.requires_delivery_platform');
    expect(liabilitySeed).not.toContain("'delivery_app'");
  });
});
