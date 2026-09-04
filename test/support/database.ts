/**
 * Test-side accessor for the real PostgreSQL provisioned by
 * `postgres.global-setup.ts`. Only for `integration` and `contract` tests.
 *
 * Phase 0 exposes a bare `pg.Client` factory so the contract suite can query
 * the catalog. Later phases add helpers here for applying migrations to a
 * fresh schema — but application code under test must still go through
 * `withTenantContext()`; nothing in this file is an approved production path.
 */
import pg from 'pg';
import { inject } from 'vitest';

export function testDatabaseUrl(): string {
  const url = inject('databaseUrl');
  if (typeof url !== 'string' || url === '') {
    throw new Error(
      'No test database URL was provided. This test must run in the `integration` or `contract` Vitest project (see vitest.config.ts).',
    );
  }
  return url;
}

export async function connectTestClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

/** Runs `fn` with a connected client and always closes it. */
export async function withTestClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connectTestClient();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
