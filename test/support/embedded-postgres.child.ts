/**
 * Runs an embedded PostgreSQL cluster in a DEDICATED child process.
 *
 * Why a separate process (do not "simplify" this back into the global setup):
 *   `embedded-postgres` imports `async-exit-hook`, which registers a
 *   `beforeExit` handler that ends the process with `process.exit(0)`
 *   (node_modules/async-exit-hook/index.js: `add.hookEvent('beforeExit', 0)`
 *   → `process.exit.bind(null, code)`). Loaded inside the Vitest main process,
 *   that handler overwrote `process.exitCode = 1` after failing tests, so a
 *   broken RLS contract would have exited 0 and kept CI green — a fail-open
 *   hole. Isolating the library here keeps the Vitest process free of foreign
 *   exit hooks; `test/unit/tools/test-harness-fail-closed.test.ts` guards this.
 *
 * Protocol (parent ↔ child):
 *   - argv[2]: JSON `{ databaseDir, port, user, password }`
 *   - child prints exactly ONE line of JSON to stdout:
 *       `{ "ok": true, "url": "postgresql://…" }`   once the server accepts connections
 *       `{ "ok": false, "error": "…" }`             if start-up failed (then exits 1)
 *   - the child stops the cluster and exits when: stdin closes, SIGTERM/SIGINT
 *     arrives, or its parent process disappears (ppid changes — orphan guard).
 *
 * Phase 1: tenant isolation probe — this child process must remain free of async-exit-hook side effects
 * Only erasable TypeScript syntax is used so Node can run this file directly
 * with its built-in type stripping (no build step, no loader).
 */
import EmbeddedPostgres from 'embedded-postgres';

interface ChildConfig {
  databaseDir: string;
  port: number;
  user: string;
  password: string;
}

interface StartupMessage {
  ok: boolean;
  url?: string;
  error?: string;
}

function emit(message: StartupMessage): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function parseConfig(raw: string | undefined): ChildConfig {
  if (raw === undefined) throw new Error('missing JSON config argument');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('config must be a JSON object');
  const candidate = parsed as Record<string, unknown>;
  const databaseDir = candidate['databaseDir'];
  const port = candidate['port'];
  const user = candidate['user'];
  const password = candidate['password'];
  if (typeof databaseDir !== 'string' || databaseDir === '') throw new Error('config.databaseDir must be a non-empty string');
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('config.port must be a TCP port number');
  if (typeof user !== 'string' || user === '') throw new Error('config.user must be a non-empty string');
  if (typeof password !== 'string' || password === '') throw new Error('config.password must be a non-empty string');
  return { databaseDir, port, user, password };
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv[2]);

  const embedded = new EmbeddedPostgres({
    databaseDir: config.databaseDir,
    port: config.port,
    user: config.user,
    password: config.password,
    authMethod: 'scram-sha-256',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
    onLog: () => {
      /* routine server log lines are not interesting to the test run */
    },
    onError: (message) => {
      process.stderr.write(`[embedded-postgres] ${typeof message === 'string' ? message : String(message)}\n`);
    },
  });

  let stopping = false;
  const stopAndExit = (code: number): void => {
    if (stopping) return;
    stopping = true;
    embedded
      .stop()
      .catch((error: unknown) => {
        process.stderr.write(`[embedded-postgres] stop failed: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
        process.exit(code);
      });
  };

  process.on('SIGTERM', () => {
    stopAndExit(0);
  });
  process.on('SIGINT', () => {
    stopAndExit(0);
  });
  process.stdin.on('end', () => {
    stopAndExit(0);
  });
  process.stdin.on('close', () => {
    stopAndExit(0);
  });
  process.stdin.resume();

  // Orphan guard: if the Vitest parent dies without tearing us down, stop the cluster.
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) stopAndExit(0);
  }, 1000).unref();

  try {
    await embedded.initialise();
    await embedded.start();
  } catch (error) {
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
    stopAndExit(1);
    return;
  }

  const url = `postgresql://${config.user}:${encodeURIComponent(config.password)}@127.0.0.1:${String(config.port)}/postgres`;
  emit({ ok: true, url });
}

main().catch((error: unknown) => {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
