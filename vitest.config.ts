/**
 * Vitest configuration — three isolated projects:
 *
 *   unit         test/unit/**         pure, fast, no I/O. Runs on every change.
 *   integration  test/integration/**  behaviour against a REAL PostgreSQL
 *                                     (RLS isolation, DISCARD ALL, locks …).
 *   contract     test/contract/**     architectural invariants checked against
 *                                     a REAL PostgreSQL catalog (pg_tables /
 *                                     pg_policies) + runtime guards (no
 *                                     InMemory repository in production).
 *
 * The integration and contract projects share one global setup
 * (`test/support/postgres.global-setup.ts`) that provisions PostgreSQL:
 *   - if `TEST_DATABASE_URL` is set (CI service container / docker compose),
 *     that server is used as-is;
 *   - otherwise an embedded PostgreSQL 18 cluster is started on a free port
 *     (works on a developer laptop with no Docker and no local Postgres).
 *
 * Both projects receive the connection string via Vitest's `provide/inject`,
 * never via a hard-coded URL. There is deliberately NO mock database option:
 * the spec forbids validating RLS against anything but a real server.
 */
import { defineConfig } from 'vitest/config';

// Phase 1: tenant-safe DB access — pools are isolated per test file via DISCARD ALL
const sharedTestOptions = {
  environment: 'node',
  clearMocks: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
} as const;

const realDatabaseProject = {
  globalSetup: ['./test/support/postgres.global-setup.ts'] as string[],
  // A real database is shared by all files of the project → run files serially
  // to keep the schema-level assertions deterministic.
  fileParallelism: false,
  testTimeout: 30_000,
  hookTimeout: 120_000,
} as const;

export default defineConfig({
  test: {
    ...sharedTestOptions,
    passWithNoTests: false,
    reporters: process.env['CI'] ? ['default', 'github-actions'] : ['default'],
    projects: [
      {
        test: {
          ...sharedTestOptions,
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          ...sharedTestOptions,
          ...realDatabaseProject,
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
        },
      },
      {
        test: {
          ...sharedTestOptions,
          ...realDatabaseProject,
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
        },
      },
    ],
  },
});
