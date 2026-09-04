/**
 * Vitest global setup for the `integration` and `contract` projects.
 *
 * Provisions a REAL PostgreSQL server and publishes its connection string to
 * the test workers via `project.provide('databaseUrl', …)` (read back with
 * `inject('databaseUrl')`, see `test/support/database.ts`).
 *
 * Resolution order:
 *   1. `TEST_DATABASE_URL` env var → use that server (CI service container,
 *      `docker compose -f docker-compose.test.yml up`, a developer's local PG).
 *   2. Otherwise → start an embedded PostgreSQL 18 cluster in a throw-away
 *      directory under `.embedded-postgres/` (git-ignored) on a free TCP port
 *      bound to 127.0.0.1 only. The cluster runs in a dedicated child process
 *      (`embedded-postgres.child.ts`) — see that file for why this isolation is
 *      a fail-closed requirement, not a style choice. It is destroyed at
 *      teardown.
 *
 * Fail-closed: if neither path yields a reachable server, setup throws and the
 * whole project fails. There is intentionally no in-memory fallback — RLS,
 * FORCE ROW LEVEL SECURITY, SET LOCAL and DISCARD ALL cannot be validated
 * against a mock, and silently skipping these tests would defeat their purpose.
 *
 * This module deliberately does NOT import `embedded-postgres` (or anything
 * that registers process exit hooks) into the Vitest main process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import type { TestProject } from 'vitest/node';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EMBEDDED_ROOT = resolve(REPO_ROOT, '.embedded-postgres');
const CHILD_SCRIPT = resolve(REPO_ROOT, 'test/support/embedded-postgres.child.ts');
const CHILD_STARTUP_TIMEOUT_MS = 90_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 15_000;

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner connection string of the throw-away test server (never a production DSN). */
    databaseUrl: string;
    /** Where the server came from — useful in failure messages. */
    databaseSource: 'env' | 'embedded';
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free TCP port'));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
  });
}

async function assertReachable(databaseUrl: string, source: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await client.query<{ version: string }>('SELECT version() AS version');
    const version = result.rows[0]?.version ?? '(unknown version)';
    console.log(`[postgres.global-setup] using ${source}: ${version}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[postgres.global-setup] PostgreSQL (${source}) is not reachable: ${reason}`, { cause: error });
  } finally {
    await client.end();
  }
}

interface EmbeddedHandle {
  url: string;
  stop: () => Promise<void>;
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveStop();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CHILD_SHUTDOWN_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    // Closing stdin is the primary shutdown signal; SIGTERM is the fallback.
    child.stdin?.end();
    child.kill('SIGTERM');
  });
}

async function startEmbedded(): Promise<EmbeddedHandle> {
  const port = await findFreePort();
  const clusterId = randomBytes(6).toString('hex');
  const databaseDir = resolve(EMBEDDED_ROOT, `cluster-${clusterId}`);
  mkdirSync(databaseDir, { recursive: true });

  // Test-only credentials for a loopback-bound, throw-away cluster. Generated
  // per run; never reused, never written to the repository.
  const config = {
    databaseDir,
    port,
    user: 'alpha_shadow_test',
    password: randomBytes(24).toString('base64url'),
  };

  const child = spawn(process.execPath, [CHILD_SCRIPT, JSON.stringify(config)], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  const cleanup = async (): Promise<void> => {
    try {
      await stopChild(child);
    } finally {
      rmSync(databaseDir, { recursive: true, force: true });
    }
  };

  const url = await new Promise<string>((resolveUrl, reject) => {
    let buffer = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        reject(new Error(`[postgres.global-setup] embedded PostgreSQL did not start within ${String(CHILD_STARTUP_TIMEOUT_MS)}ms`));
      });
    }, CHILD_STARTUP_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        settle(() => {
          reject(new Error(`[postgres.global-setup] unexpected output from embedded PostgreSQL child: ${line}`));
        });
        return;
      }
      const m = message as { ok?: unknown; url?: unknown; error?: unknown };
      if (m.ok === true && typeof m.url === 'string') {
        const started = m.url;
        settle(() => {
          resolveUrl(started);
        });
      } else {
        const reason = typeof m.error === 'string' ? m.error : line;
        settle(() => {
          reject(new Error(`[postgres.global-setup] embedded PostgreSQL failed to start: ${reason}`));
        });
      }
    });
    child.once('error', (error) => {
      settle(() => {
        reject(new Error(`[postgres.global-setup] could not spawn embedded PostgreSQL child: ${error.message}`, { cause: error }));
      });
    });
    child.once('exit', (code, signal) => {
      settle(() => {
        reject(new Error(`[postgres.global-setup] embedded PostgreSQL child exited before it was ready (code=${String(code)} signal=${String(signal)})`));
      });
    });
  }).catch(async (error: unknown) => {
    await cleanup().catch(() => undefined);
    throw error;
  });

  return { url, stop: cleanup };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const fromEnv = process.env['TEST_DATABASE_URL'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    await assertReachable(fromEnv, 'TEST_DATABASE_URL');
    project.provide('databaseUrl', fromEnv);
    project.provide('databaseSource', 'env');
    return async () => {
      /* externally managed server: nothing to tear down */
    };
  }

  const embedded = await startEmbedded();
  try {
    await assertReachable(embedded.url, `embedded PostgreSQL at ${embedded.url.replace(/\/\/.*@/, '//***@')}`);
  } catch (error) {
    await embedded.stop().catch(() => undefined);
    throw error;
  }

  project.provide('databaseUrl', embedded.url);
  project.provide('databaseSource', 'embedded');
  return embedded.stop;
}
