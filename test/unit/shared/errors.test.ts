import { describe, expect, it } from 'vitest';

import { ConfigurationError, ConflictError, DomainError, NotFoundError, ValidationError } from '../../../src/shared/errors.ts';

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
});
