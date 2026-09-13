/**
 * R1 (backlog, security) — KDS device tokens, live acceptance.
 *
 * The KDS realtime server used to accept TOKENLESS connections (pre-fix gap:
 * both gap tests below were green while asserting 200/streamed events before
 * the R1 commit; the R1 implementation flipped them to assert rejection).
 * Every test runs against a REAL PostgreSQL (RLS, FK RESTRICT, the
 * tenant_isolation policy on kds_device_tokens).
 *
 * Coverage:
 *   engine  — issue (hash-only storage, admin gate, input validation),
 *             revoke (instant flip, idempotent, NotFound, admin gate),
 *             verify (valid/unknown/revoked/cross-branch/cross-tenant/
 *             malformed — one uniform failure, no oracle),
 *             isDeviceTokenActive (the revalidation probe);
 *   server  — gap-closed 401s (polling + WebSocket), happy paths (header +
 *             query forms, real-client WebSocket), revocation immediate for
 *             new connections, cross-branch/cross-tenant rejection,
 *             brute-force 429 + success-reset, infra-failure 503 (fail-closed,
 *             never counted), instant open-connection kill, revalidation
 *             backstop without the kill call.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { KdsDeviceEngine } from '../../src/application/engines/kds/kds-device-engine.ts';
import { AuthorizationEngine } from '../../src/application/engines/rbac/authorization-engine.ts';
import type { OrderOutboxEvent } from '../../src/domain/contracts/orders.ts';
import { createWithTenantContext, type WithTenantContext } from '../../src/infrastructure/db/tenant-context.ts';
import { PostgresKdsDeviceTokenStore } from '../../src/infrastructure/db/repositories/postgres-kds-device-token-store.ts';
import { PostgresPermissionReadRepository, PostgresPermissionWriteRepository } from '../../src/infrastructure/db/repositories/postgres-permission-repository.ts';
import { KdsRealtimeClient, type KdsClientEvent } from '../../src/presentation/kds/kds-realtime-client.ts';
import { KdsRealtimeServer } from '../../src/presentation/kds/kds-realtime-server.ts';
import { hashPin } from '../../src/shared/auth/pin.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/shared/errors.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { grantKeys } from '../support/grant-keys.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PIN_PEPPER = Buffer.from(randomBytes(48));

function canned(tenantId: string, branchId: string): OrderOutboxEvent {
  return {
    id: randomUUID(),
    tenantId,
    branchId,
    sequenceId: 1,
    eventType: 'order_item_status_changed',
    payload: { order_id: randomUUID() },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

async function grantBranchKeys(
  write: PostgresPermissionWriteRepository,
  tenantId: string,
  userId: string,
  branchId: string,
  keys: readonly string[],
): Promise<void> {
  const roleId = await write.createRole(tenantId, `r1-branch-grant-${randomUUID()}`);
  for (const key of keys) {
    await write.assignRolePermission(tenantId, roleId, key, null);
  }
  await write.assignUserRole(tenantId, userId, roleId, 'branch', branchId);
}

describe('R1 live acceptance (KDS device tokens)', () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let withApp: WithTenantContext;
  let permWrite: PostgresPermissionWriteRepository;
  let kdsDevices: KdsDeviceEngine;
  let issuerId: string;
  let plainUserId: string;
  let branchA1: string;
  let branchA2: string;
  let branchB1: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
    for (const file of ['001_app_login.sql', '002_app_login_rbac.sql', '014_backlog_r1_kds_device_tokens.sql']) {
      await owner.query(await readFile(new URL(`../../migrations/roles/${file}`, import.meta.url), 'utf8'));
    }
    const appPassword = randomBytes(24).toString('hex');
    await owner.query(`ALTER ROLE app_login LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    const appUrl = new URL(testDatabaseUrl());
    appUrl.username = 'app_login';
    appUrl.password = appPassword;
    app = new pg.Pool({ connectionString: appUrl.toString(), max: 5 });
    withApp = createWithTenantContext(app, { verifyTenantExists: true });
    permWrite = new PostgresPermissionWriteRepository({ withTenantContext: withApp });
    const permissionRead = new PostgresPermissionReadRepository({ withTenantContext: withApp });
    const authorization = new AuthorizationEngine({ read: permissionRead, hash: sha256Hex });
    kdsDevices = new KdsDeviceEngine({ store: new PostgresKdsDeviceTokenStore({ withTenantContext: withApp }), authorization });

    issuerId = randomUUID();
    plainUserId = randomUUID();
    await withApp(A, async (q) => {
      await q.query('INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)', [issuerId, A, `${issuerId}@example.test`, hashPin(PIN_PEPPER, A, issuerId, '0000')]);
      await q.query('INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)', [plainUserId, A, `${plainUserId}@example.test`, hashPin(PIN_PEPPER, A, plainUserId, '0000')]);
    });
    await grantKeys(permWrite, A, issuerId, ['payments:methods_admin']);

    branchA1 = randomUUID();
    branchA2 = randomUUID();
    branchB1 = randomUUID();
    for (const [branchId, tenantId] of [[branchA1, A], [branchA2, A], [branchB1, B]] as const) {
      await owner.query("INSERT INTO branches (id, tenant_id, name, base_currency, timezone, country_code) VALUES ($1, $2, 'r1-branch', 'SAR', 'Asia/Riyadh', 'SA')", [branchId, tenantId]);
    }
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  function wireAuth(extra: Partial<ConstructorParameters<typeof KdsRealtimeServer>[0]> = {}): ConstructorParameters<typeof KdsRealtimeServer>[0] {
    return {
      readEvents: async (tenantId, branchId) => [canned(tenantId, branchId)],
      verifyDeviceToken: (tenantId, branchId, token) => kdsDevices.verifyDeviceToken(tenantId, branchId, token),
      isTokenHashActive: (tenantId, tokenHash) => kdsDevices.isDeviceTokenActive(tenantId, tokenHash),
      ...extra,
    };
  }

  // ── engine: issue ─────────────────────────────────────────────────────

  it('#1 issue mints a 43-char token, stores ONLY its sha256-hex, and records label/branch/minter', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'Grill KDS 1' });
    expect(issued.plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.record.status).toBe('active');
    expect(issued.record).toMatchObject({ tenantId: A, branchId: branchA1, label: 'Grill KDS 1', createdBy: issuerId, lastUsedAt: null });
    expect(issued.record.tokenHash).toBe(sha256Hex(issued.plaintextToken));

    const stored = await owner.query('SELECT * FROM kds_device_tokens WHERE id = $1', [issued.record.id]);
    expect(stored.rows).toHaveLength(1);
    // The plaintext appears NOWHERE in the persisted row — a dump yields no credential.
    expect(JSON.stringify(stored.rows[0])).not.toContain(issued.plaintextToken);
  });

  it('#2 issue without the admin key is refused (ForbiddenError)', async () => {
    await expect(kdsDevices.issueDeviceToken(A, plainUserId, { branchId: branchA1, label: 'x' })).rejects.toThrow(ForbiddenError);
  });

  it('#3 issue validates input (bad branch id, over-long label)', async () => {
    await expect(kdsDevices.issueDeviceToken(A, issuerId, { branchId: 'not-a-uuid', label: 'x' })).rejects.toThrow(ValidationError);
    await expect(kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'l'.repeat(201) })).rejects.toThrow(ValidationError);
  });

  // ── engine: revoke ────────────────────────────────────────────────────

  it('#4 revoke flips active→revoked (row survives), re-revoke is idempotent success', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'revoke-me' });
    const revoked = await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
    expect(revoked.status).toBe('revoked');
    const again = await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
    expect(again.status).toBe('revoked');
    const stored = await owner.query('SELECT status FROM kds_device_tokens WHERE id = $1', [issued.record.id]);
    expect(stored.rows[0]).toEqual({ status: 'revoked' });
  });

  it('#5 revoke of an unknown id is NotFound; revoke without the admin key is refused', async () => {
    await expect(kdsDevices.revokeDeviceToken(A, issuerId, randomUUID())).rejects.toThrow(NotFoundError);
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'not-yours' });
    await expect(kdsDevices.revokeDeviceToken(A, plainUserId, issued.record.id)).rejects.toThrow(ForbiddenError);
  });

  it('[AUTH-BR-12/13] issue and revoke honor branch-scoped payments:methods_admin grants', async () => {
    const subjectId = randomUUID();
    await withApp(A, async (q) => {
      await q.query('INSERT INTO users (id, tenant_id, email, pin_hash) VALUES ($1, $2, $3, $4)', [subjectId, A, `${subjectId}@example.test`, hashPin(PIN_PEPPER, A, subjectId, '0000')]);
    });
    await grantBranchKeys(permWrite, A, subjectId, branchA1, ['payments:methods_admin']);

    const issuedA1 = await kdsDevices.issueDeviceToken(A, subjectId, { branchId: branchA1, label: 'branch-a1' });
    await expect(kdsDevices.issueDeviceToken(A, subjectId, { branchId: branchA2, label: 'branch-a2-denied' })).rejects.toThrow(ForbiddenError);

    const issuedA2 = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA2, label: 'branch-a2' });
    await expect(kdsDevices.revokeDeviceToken(A, subjectId, issuedA1.record.id)).resolves.toMatchObject({ status: 'revoked' });
    await expect(kdsDevices.revokeDeviceToken(A, subjectId, issuedA2.record.id)).rejects.toThrow(ForbiddenError);
  });

  // ── engine: verify ────────────────────────────────────────────────────

  it('#6 verify accepts the valid token (touching last_used_at) and uniformly rejects unknown/revoked/cross-branch/cross-tenant/empty', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'verify-me' });
    const ok = await kdsDevices.verifyDeviceToken(A, branchA1, issued.plaintextToken);
    expect(ok).toEqual({ verified: true, tokenId: issued.record.id, tokenHash: sha256Hex(issued.plaintextToken) });
    const touched = await owner.query('SELECT last_used_at FROM kds_device_tokens WHERE id = $1', [issued.record.id]);
    expect(touched.rows[0]?.last_used_at).not.toBeNull();

    const failures = [
      await kdsDevices.verifyDeviceToken(A, branchA1, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      await kdsDevices.verifyDeviceToken(A, branchA2, issued.plaintextToken),
      await kdsDevices.verifyDeviceToken(B, branchB1, issued.plaintextToken),
      await kdsDevices.verifyDeviceToken(A, branchA1, ''),
    ];
    for (const failure of failures) expect(failure).toEqual({ verified: false, tokenId: null, tokenHash: null });

    await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
    expect(await kdsDevices.verifyDeviceToken(A, branchA1, issued.plaintextToken)).toEqual({ verified: false, tokenId: null, tokenHash: null });
  });

  it('#7 isDeviceTokenActive is true only for active rows (the revalidation probe)', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'probe-me' });
    const hash = sha256Hex(issued.plaintextToken);
    expect(await kdsDevices.isDeviceTokenActive(A, hash)).toBe(true);
    expect(await kdsDevices.isDeviceTokenActive(A, '0'.repeat(64))).toBe(false);
    await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
    expect(await kdsDevices.isDeviceTokenActive(A, hash)).toBe(false);
  });

  // ── server: gap closed ────────────────────────────────────────────────

  it('#8 GAP-CLOSED polling: tokenless GET is 401 with no events (was 200 pre-R1)', async () => {
    const server = new KdsRealtimeServer(wireAuth());
    const port = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await server.stop();
    }
  });

  it('#9 GAP-CLOSED websocket: tokenless upgrade is rejected with 401 (streamed pre-R1)', async () => {
    const server = new KdsRealtimeServer(wireAuth({ pollIntervalMs: 20 }));
    const port = await server.start();
    try {
      const outcome = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/ws`);
        socket.on('open', () => { resolve('OPENED'); });
        socket.on('error', (error: Error) => { resolve(error.message); });
      });
      expect(outcome).toContain('401');
    } finally {
      await server.stop();
    }
  });

  // ── server: happy paths ───────────────────────────────────────────────

  it('#10 polling with a header token returns 200 with the branch events', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'poll-screen' });
    const server = new KdsRealtimeServer(wireAuth());
    const port = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
        headers: { authorization: `Bearer ${issued.plaintextToken}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { events?: unknown[] };
      expect(body.events).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('#11 polling also accepts the ?token= query form (header-less clients)', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'query-screen' });
    const server = new KdsRealtimeServer(wireAuth());
    const port = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0&token=${encodeURIComponent(issued.plaintextToken)}`);
      expect(response.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('#12 websocket via the real client streams events (client query wiring end-to-end)', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'ws-screen' });
    const server = new KdsRealtimeServer(wireAuth({ pollIntervalMs: 20 }));
    const port = await server.start();
    const received: KdsClientEvent[] = [];
    const client = new KdsRealtimeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      tenantId: A,
      branchId: branchA1,
      deviceToken: issued.plaintextToken,
      onEvent: (event) => received.push(event),
    });
    try {
      client.start();
      await waitFor(() => received.length >= 1);
      expect(received[0]?.sequenceId).toBe(1);
    } finally {
      await client.stop();
      await server.stop();
    }
  });

  // ── server: rejection paths ───────────────────────────────────────────

  it('#13 wrong token is 401 on polling and rejected on websocket (no oracle vs missing)', async () => {
    const server = new KdsRealtimeServer(wireAuth({ pollIntervalMs: 20 }));
    const port = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
        headers: { authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });

      const outcome = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/ws?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
        socket.on('open', () => { resolve('OPENED'); });
        socket.on('error', (error: Error) => { resolve(error.message); });
      });
      expect(outcome).toContain('401');
    } finally {
      await server.stop();
    }
  });

  it('#14 malformed Authorization values are 401 (never a throw, never a bypass)', async () => {
    const server = new KdsRealtimeServer(wireAuth());
    const port = await server.start();
    try {
      for (const header of ['Bearer', 'Bearer ', 'Basic Zm9v', 'Token abc', '']) {
        const response = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
          headers: header === '' ? {} : { authorization: header },
        });
        expect(response.status).toBe(401);
      }
    } finally {
      await server.stop();
    }
  });

  it('#15 cross-branch and cross-tenant presentation are rejected on both transports', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'home-branch' });
    const server = new KdsRealtimeServer(wireAuth({ pollIntervalMs: 20 }));
    const port = await server.start();
    try {
      // Same tenant, sibling branch.
      const crossBranch = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA2}/events?after=0`, {
        headers: { authorization: `Bearer ${issued.plaintextToken}` },
      });
      expect(crossBranch.status).toBe(401);
      // Sibling tenant.
      const crossTenant = await fetch(`http://127.0.0.1:${port}/kds/${B}/branches/${branchB1}/events?after=0`, {
        headers: { authorization: `Bearer ${issued.plaintextToken}` },
      });
      expect(crossTenant.status).toBe(401);
      // And the token still works on its HOME branch (the rejections were scope, not state).
      const home = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
        headers: { authorization: `Bearer ${issued.plaintextToken}` },
      });
      expect(home.status).toBe(200);
      // Cross-branch over websocket.
      const outcome = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/kds/${A}/branches/${branchA2}/ws?token=${encodeURIComponent(issued.plaintextToken)}`);
        socket.on('open', () => { resolve('OPENED'); });
        socket.on('error', (error: Error) => { resolve(error.message); });
      });
      expect(outcome).toContain('401');
    } finally {
      await server.stop();
    }
  });

  it('#16 revocation is immediate for NEW connections (200 before, 401 after)', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'revoke-fast' });
    const server = new KdsRealtimeServer(wireAuth());
    const port = await server.start();
    try {
      const before = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
        headers: { authorization: `Bearer ${issued.plaintextToken}` },
      });
      expect(before.status).toBe(200);
      await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
      const after = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
        headers: { authorization: `Bearer ${issued.plaintextToken}` },
      });
      expect(after.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  // ── server: limiter + infra ───────────────────────────────────────────

  it('#17 brute force is braked: 3 failures are 401, the 4th is 429, a success resets the counter', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'limited' });
    const server = new KdsRealtimeServer(wireAuth({ authFailureLimit: 3, authFailureWindowMs: 60_000 }));
    const port = await server.start();
    const attempt = (token: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
        headers: { authorization: `Bearer ${token}` },
      });
    try {
      expect((await attempt('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).status).toBe(401);
      expect((await attempt('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).status).toBe(401);
      expect((await attempt('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).status).toBe(401);
      const limited = await attempt('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'rate_limited' });
      // A success resets the bucket: the next failure is 401 again, not 429.
      expect((await attempt(issued.plaintextToken)).status).toBe(200);
      expect((await attempt('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('#18 verification infra failure is fail-closed 503 and never feeds the limiter', async () => {
    const server = new KdsRealtimeServer({
      readEvents: async (tenantId, branchId) => [canned(tenantId, branchId)],
      verifyDeviceToken: async () => { throw new Error('simulated database outage'); },
      isTokenHashActive: async () => true,
      authFailureLimit: 2,
      authFailureWindowMs: 60_000,
    });
    const port = await server.start();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/events?after=0`, {
          headers: { authorization: 'Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'unavailable' });
      }
    } finally {
      await server.stop();
    }
  });

  // ── server: open-connection revocation ────────────────────────────────

  it('#19 wired revocation drops the OPEN websocket immediately (1008 token_revoked)', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'kill-me' });
    const server = new KdsRealtimeServer(wireAuth({ pollIntervalMs: 20 }));
    const port = await server.start();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/ws?token=${encodeURIComponent(issued.plaintextToken)}`);
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => {
          socket.send(JSON.stringify({ type: 'subscribe', last_sequence_id: 0 }));
          resolve();
        });
        socket.on('error', reject);
      });
      let messages = 0;
      socket.on('message', () => { messages += 1; });
      await waitFor(() => messages >= 1);
      // Revoke + wired kill: the open socket must die with 1008.
      await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.on('close', (code: number, reason: Buffer) => { resolve({ code, reason: reason.toString() }); });
      });
      expect(server.revokeConnectionsForTokenHash(sha256Hex(issued.plaintextToken))).toBe(1);
      const closed = await closePromise;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('token_revoked');
    } finally {
      await server.stop();
    }
  });

  it('#20 the revalidation backstop drops a revoked socket even WITHOUT the wired kill', async () => {
    const issued = await kdsDevices.issueDeviceToken(A, issuerId, { branchId: branchA1, label: 'backstop' });
    const server = new KdsRealtimeServer(wireAuth({ pollIntervalMs: 20, revalidationMs: 30 }));
    const port = await server.start();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/kds/${A}/branches/${branchA1}/ws?token=${encodeURIComponent(issued.plaintextToken)}`);
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => {
          socket.send(JSON.stringify({ type: 'subscribe', last_sequence_id: 0 }));
          resolve();
        });
        socket.on('error', reject);
      });
      let messages = 0;
      let closeCode = 0;
      socket.on('message', () => { messages += 1; });
      socket.on('close', (code: number) => { closeCode = code; });
      await waitFor(() => messages >= 1);
      // Revoke WITHOUT calling revokeConnectionsForTokenHash: the backstop
      // (30ms schedule) must still close the socket with 1008.
      await kdsDevices.revokeDeviceToken(A, issuerId, issued.record.id);
      await waitFor(() => closeCode !== 0);
      expect(closeCode).toBe(1008);
    } finally {
      await server.stop();
    }
  });
});
