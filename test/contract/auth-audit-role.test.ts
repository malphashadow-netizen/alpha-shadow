/**
 * Contract: the dedicated `app_audit` role is least-privilege — it can
 * EXECUTE the two SECURITY DEFINER audit functions but cannot touch tenant
 * tables directly. We create the role in the disposable test cluster, apply
 * the grants from migrations/roles/003_app_audit.sql semantics, and connect
 * as that role to PROVE the containment (not just inspect the catalog).
 *
 * Role creation is cluster-global, so this test creates a uniquely-named copy
 * of the role (`app_audit_contract_<random>`) and drops it in finally — the
 * throw-away test database is wiped per CI run anyway.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { connectTestClient, testDatabaseUrl } from '../support/database.ts';

const ROLE_NAME = `app_audit_contract_${Math.floor(Math.random() * 1e9)}`;

describe('contract: app_audit least-privilege role (live)', () => {
  let auditClient: pg.Client;

  beforeAll(async () => {
    const creator = await connectTestClient();
    try {
      // Create the NOLOGIN-equivalent test role WITH LOGIN (so we can connect
      // in the throw-away cluster) and with the same hardening attributes.
      await creator.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE_NAME}') THEN
             CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'ephemeral-test-only';
           END IF;
         END $$;`,
      );
      await creator.query(`GRANT USAGE ON SCHEMA public TO ${ROLE_NAME}`);
      // Grant ONLY function execution (mirrors roles/003).
      await creator.query(
        `GRANT EXECUTE ON FUNCTION record_auth_attempt(uuid, text, text, text, boolean, text, text) TO ${ROLE_NAME}`,
      );
      await creator.query(
        `GRANT EXECUTE ON FUNCTION count_recent_auth_failures(text, text, text, integer) TO ${ROLE_NAME}`,
      );
      // Explicitly ensure NO table grants exist (revoke everything just in case).
      await creator.query(
        `REVOKE ALL ON tenants, permissions_registry, branches, users, roles, role_permissions, user_roles, auth_refresh_tokens, auth_audit_log FROM ${ROLE_NAME}`,
      );
    } finally {
      await creator.end();
    }

    // Connect AS the audit role.
    const url = new URL(testDatabaseUrl());
    url.username = ROLE_NAME;
    url.password = 'ephemeral-test-only';
    auditClient = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
    await auditClient.connect();
  });

  afterAll(async () => {
    await auditClient?.end().catch(() => undefined);
    const dropper = await connectTestClient();
    try {
      // Remove the grants (DROP OWNED) before dropping the role, otherwise the
      // role still "depends on" its function privileges.
      await dropper.query(`DROP OWNED BY ${ROLE_NAME}`);
      await dropper.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
    } finally {
      await dropper.end();
    }
  });

  it('can record an auth attempt via the SECURITY DEFINER function', async () => {
    await expect(
      auditClient.query(
        `SELECT record_auth_attempt($1::uuid, $2, $3, 'password', false, $4, $5)`,
        [null, null, `role-probe-${Math.random()}`, '198.51.100.2', 'contract'],
      ),
    ).resolves.toBeDefined();
  });

  it('can count recent failures via the SECURITY DEFINER function', async () => {
    const result = await auditClient.query<{ count_recent_auth_failures: number }>(
      `SELECT count_recent_auth_failures('password', $1, $2, $3) AS count_recent_auth_failures`,
      ['198.51.100.2', 'nonexistent-identifier', 15 * 60 * 1000],
    );
    expect(typeof result.rows[0]?.count_recent_auth_failures).toBe('number');
  });

  it('CANNOT read the audit table directly (no SELECT grant)', async () => {
    await expect(auditClient.query('SELECT count(*) FROM auth_audit_log')).rejects.toThrow(/permission denied/);
  });

  it('CANNOT insert into the audit table directly (no INSERT grant)', async () => {
    await expect(
      auditClient.query(
        `INSERT INTO auth_audit_log (identifier_attempted, mode, success) VALUES ('x', 'password', false)`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT read tenant-scoped tables directly (no grant / RLS)', async () => {
    // Either an explicit privilege denial OR the RLS predicate failing
    // (undefined tenant setting) proves the role cannot enumerate rows —
    // both are access denials, never a successful read.
    const denial = /permission denied|unrecognized configuration parameter|row-level security|new row violates row-level security policy/;
    await expect(auditClient.query('SELECT count(*) FROM users')).rejects.toThrow(denial);
    await expect(auditClient.query('SELECT count(*) FROM auth_refresh_tokens')).rejects.toThrow(denial);
  });
});
