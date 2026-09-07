/**
 * Unit tests for the HTTP-level auth handler contract:
 *  - malformed bodies are 400 BEFORE any engine/DB call (engine never created);
 *  - every credential failure is the IDENTICAL 401 INVALID_CREDENTIALS — same
 *    body AND headers (acceptance #5);
 *  - an unconfigured security layer (missing secret) yields a constant 503;
 *  - successful login/refresh return 200 tokens.
 */
import { describe, expect, it, vi } from 'vitest';

import { InvalidCredentialsError } from '../../../src/shared/errors.ts';
import { createAuthHandlers } from '../../../src/presentation/routes/auth.ts';
import { RateLimitError } from '../../../src/shared/errors.ts';

function engineThatThrows(error: unknown) {
  return {
    login: vi.fn(async () => {
      throw error;
    }),
    refresh: vi.fn(async () => {
      throw error;
    }),
  };
}

describe('auth HTTP handlers', () => {
  it('rejects a malformed login body with 400 and never touches the engine', async () => {
    const factory = vi.fn(() => engineThatThrows(new Error('should not run')));
    const handlers = createAuthHandlers(factory);
    const res = await handlers.login({ body: { mode: 'pin', tenantId: 't' }, ipAddress: '1.2.3.4' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'validation.failed' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects both-modes-present with 400 before any DB call', async () => {
    const factory = vi.fn(() => {
      throw new Error('should not run');
    });
    const handlers = createAuthHandlers(factory);
    const res = await handlers.login({
      body: { mode: 'password', tenantId: '11111111-1111-4111-8111-111111111111', email: 'a@x.com', password: 'p', pin: '1' },
      ipAddress: '1.2.3.4',
    });
    expect(res.status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });

  it('every credential failure is the IDENTICAL 401 INVALID_CREDENTIALS (body + headers)', async () => {
    const handlers = createAuthHandlers(() => engineThatThrows(new InvalidCredentialsError('x')));
    const body = { mode: 'password', tenantId: '11111111-1111-4111-8111-111111111111', email: 'a@x.com', password: 'p' };
    const res = await handlers.login({ body, ipAddress: '9.9.9.9', userAgent: 'ua' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    // Headers are minimal and identical for every credential failure —
    // no Retry-After / WWW-Authenticate that could distinguish account state.
    expect(Object.keys(res.headers).sort()).toEqual(['content-type']);

    // Same for refresh.
    const refreshRes = await handlers.refresh({ body: { refreshToken: 'a.b.c' }, ipAddress: '9.9.9.9' });
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body).toEqual(res.body);
    expect(refreshRes.headers).toEqual(res.headers);
  });

  it('a missing/invalid secret (factory throws) yields a constant 503', async () => {
    const handlers = createAuthHandlers(() => {
      throw new Error('PIN_HASH_PEPPER is not set');
    });
    const loginRes = await handlers.login({
      body: { mode: 'password', tenantId: '11111111-1111-4111-8111-111111111111', email: 'a@x.com', password: 'p' },
    });
    expect(loginRes.status).toBe(503);
    expect(loginRes.body).toMatchObject({ code: 'service.unavailable' });
    // The secret VALUE/config detail never crosses the boundary.
    expect(JSON.stringify(loginRes.body)).not.toContain('PIN_HASH_PEPPER is not set');

    const refreshRes = await handlers.refresh({ body: { refreshToken: 'a.b.c' } });
    expect(refreshRes.status).toBe(503);
  });

  it('rate limiting surfaces as 429 but never reveals account state', async () => {
    const handlers = createAuthHandlers(() => engineThatThrows(new RateLimitError('rate limit exceeded')));
    const res = await handlers.login({
      body: { mode: 'password', tenantId: '11111111-1111-4111-8111-111111111111', email: 'a@x.com', password: 'p' },
    });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'rate_limit.exceeded' });
  });

  it('a successful login returns 200 with tokens', async () => {
    const engine = {
      login: vi.fn(async () => ({ status: 'ok' as const, accessToken: 'at', refreshToken: 'rt', userId: 'u', tenantId: 't' })),
      refresh: vi.fn(async () => ({ status: 'ok' as const, accessToken: 'at', refreshToken: 'rt2', userId: 'u', tenantId: 't' })),
    };
    const handlers = createAuthHandlers(() => engine);
    const res = await handlers.login({
      body: { mode: 'password', tenantId: '11111111-1111-4111-8111-111111111111', email: 'a@x.com', password: 'p' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer' });
  });

  it('malformed refresh body is 400 before the engine runs', async () => {
    const factory = vi.fn(() => engineThatThrows(new Error('no')));
    const handlers = createAuthHandlers(factory);
    const res = await handlers.refresh({ body: { refreshToken: 'only-one-segment' } });
    expect(res.status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });
});
