import { describe, expect, it } from 'vitest';

import {
  AuthorizationError,
  ConfigurationError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  TenantIsolationViolationError,
  toErrorResponse,
  ValidationError,
} from '../../../src/shared/errors.ts';

describe('shared/errors — hierarchy', () => {
  it('ValidationError carries message and optional field with declare semantics', () => {
    const withField = new ValidationError('bad', 'email');
    expect(withField.message).toBe('bad');
    expect(withField.field).toBe('email');
    expect(withField.code).toBe('validation.failed');
    expect(Object.prototype.hasOwnProperty.call(withField, 'field')).toBe(true);
    expect(withField instanceof DomainError).toBe(true);
    expect(withField instanceof ValidationError).toBe(true);
  });

  it('ValidationError without field has no own property field', () => {
    const without = new ValidationError('bad');
    expect(Object.prototype.hasOwnProperty.call(without, 'field')).toBe(false);
    // Accessing field should be undefined via prototype, but not own property
    expect((without as ValidationError).field).toBeUndefined();
  });

  it('ValidationError with undefined field explicitly does not create property', () => {
    const e = new ValidationError('bad', undefined);
    expect(Object.prototype.hasOwnProperty.call(e, 'field')).toBe(false);
  });

  it('ValidationError field declared with declare does not create undefined own property', () => {
    const e = new ValidationError('x');
    expect('field' in e).toBe(false); // in checks prototype chain, but declare means no own property
    // Actually 'field' in e would be false because declare doesn't define property at all when not assigned
    expect(Object.hasOwn(e, 'field')).toBe(false);
  });

  it('NotFoundError and ConflictError extend DomainError with correct codes', () => {
    const nf = new NotFoundError('not found');
    expect(nf.code).toBe('not_found');
    expect(nf instanceof DomainError).toBe(true);
    expect(nf.name).toBe('NotFoundError');

    const cf = new ConflictError('conflict');
    expect(cf.code).toBe('conflict');
    expect(cf instanceof DomainError).toBe(true);
    expect(cf.name).toBe('ConflictError');
  });

  it('ConfigurationError carries key when provided', () => {
    const ce = new ConfigurationError('missing', 'DATABASE_URL');
    expect(ce.code).toBe('config.invalid');
    expect((ce as ConfigurationError).key).toBe('DATABASE_URL');
    expect(Object.prototype.hasOwnProperty.call(ce, 'key')).toBe(true);
  });

  it('ConfigurationError without key has no own property', () => {
    const ce = new ConfigurationError('missing');
    expect(Object.prototype.hasOwnProperty.call(ce, 'key')).toBe(false);
  });

  it('all errors are instanceof Error', () => {
    expect(new ValidationError('a') instanceof Error).toBe(true);
    expect(new NotFoundError('a') instanceof Error).toBe(true);
    expect(new ConflictError('a') instanceof Error).toBe(true);
    expect(new ConfigurationError('a') instanceof Error).toBe(true);
  });

  it('ValidationError with field preserves field after instanceof checks', () => {
    const e: DomainError = new ValidationError('msg', 'myField');
    if (e instanceof ValidationError) {
      expect(e.field).toBe('myField');
    } else {
      throw new Error('not ValidationError');
    }
  });

  it('DomainError name is constructor name', () => {
    const e = new ValidationError('oops', 'f');
    expect(e.name).toBe('ValidationError');
    const n = new NotFoundError('x');
    expect(n.name).toBe('NotFoundError');
  });

  it('AuthorizationError / ForbiddenError are explicit domain errors with stable codes', () => {
    const authz = new AuthorizationError('token missing');
    expect(authz.code).toBe('authorization.failed');
    expect(authz.name).toBe('AuthorizationError');
    expect(authz instanceof DomainError).toBe(true);

    const forbidden = new ForbiddenError('not allowed');
    expect(forbidden.code).toBe('forbidden');
    expect(forbidden.name).toBe('ForbiddenError');
    expect(forbidden instanceof DomainError).toBe(true);
    expect(forbidden instanceof AuthorizationError).toBe(false);
  });

  it('TenantIsolationViolationError and RateLimitError have dedicated stable codes', () => {
    const isolation = new TenantIsolationViolationError('cross-tenant access attempt blocked');
    expect(isolation.code).toBe('tenant_isolation.violation');
    expect(isolation.name).toBe('TenantIsolationViolationError');
    expect(isolation instanceof DomainError).toBe(true);

    const rate = new RateLimitError('too many requests');
    expect(rate.code).toBe('rate_limit.exceeded');
    expect(rate.name).toBe('RateLimitError');
    expect(rate instanceof DomainError).toBe(true);
  });
});

describe('shared/errors — central error mapping (toErrorResponse)', () => {
  it('maps every domain error to the agreed HTTP status', () => {
    const noop = (): void => undefined;
    expect(toErrorResponse(new ValidationError('bad', 'f'), noop).status).toBe(400);
    expect(toErrorResponse(new AuthorizationError('unauth'), noop).status).toBe(401);
    expect(toErrorResponse(new ForbiddenError('no'), noop).status).toBe(403);
    expect(toErrorResponse(new TenantIsolationViolationError('iso'), noop).status).toBe(403);
    expect(toErrorResponse(new NotFoundError('nf'), noop).status).toBe(404);
    expect(toErrorResponse(new ConflictError('c'), noop).status).toBe(409);
    expect(toErrorResponse(new RateLimitError('rl'), noop).status).toBe(429);
    expect(toErrorResponse(new ConfigurationError('cfg'), noop).status).toBe(500);
  });

  it('obscures non-domain errors (no stack/leak in the response) and logs them server-side', () => {
    const logs: unknown[] = [];
    const response = toErrorResponse(new Error('secret internal detail'), (e) => logs.push(e));
    expect(response).toEqual({ status: 500, code: 'internal.error', message: 'Internal server error' });
    expect(JSON.stringify(response)).not.toContain('secret internal detail');
    // The detailed error goes ONLY to the server-side log sink.
    expect(logs).toHaveLength(1);
  });

  it('REDACTS ConfigurationError details from the response message (500 class) while logging them', () => {
    const secretDsn = 'postgresql://postgres:super-secret-pw@db.corp.internal:5432/prod?sslmode=require';
    const detailed = `DATABASE_URL points at the default postgres superuser URL ("${secretDsn}"); use a least-privilege application role.`;
    const logs: unknown[] = [];

    const response = toErrorResponse(new ConfigurationError(detailed, 'DATABASE_URL'), (e) => logs.push(e));

    expect(response.code).toBe('config.invalid');
    expect(response.status).toBe(500);
    expect(response.message).toBe('Internal server error');
    expect(response.message).not.toContain('super-secret-pw');
    expect(response.message).not.toContain('db.corp.internal');
    expect(JSON.stringify(response)).not.toContain('super-secret-pw');
    // Real detail is delivered to the server-side sink only.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBeInstanceOf(ConfigurationError);
  });

  it('redacts unknown future domain codes (500 class) too — never a message echo', () => {
    class FutureInternalError extends DomainError {
      readonly code = 'some.future.internal' as const;
    }
    const logs: unknown[] = [];
    const response = toErrorResponse(new FutureInternalError('secret future detail'), (e) => logs.push(e));
    expect(response.status).toBe(500);
    expect(response.message).toBe('Internal server error');
    expect(JSON.stringify(response)).not.toContain('secret future detail');
    expect(logs).toHaveLength(1);
  });

  it('keeps client-safe 4xx messages (validation etc.) but still maps 500 for config errors', () => {
    expect(toErrorResponse(new ValidationError('bad email', 'email'), () => undefined).message).toBe('bad email');
    expect(toErrorResponse(new ConflictError('conflict row'), () => undefined).message).toBe('conflict row');
    expect(toErrorResponse(new ConfigurationError('cfg only', 'K'), () => undefined).message).toBe('Internal server error');
  });

  it('keeps the stable code in the response body', () => {
    expect(toErrorResponse(new RateLimitError('x'), () => undefined).code).toBe('rate_limit.exceeded');
    expect(toErrorResponse(new TenantIsolationViolationError('x'), () => undefined).code).toBe('tenant_isolation.violation');
  });
});
