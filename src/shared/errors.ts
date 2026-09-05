/**
 * Error hierarchy for the domain and shared layers.
 *
 * Every error carries a stable `code` for machine-readable branching.
 * DomainError is the abstract base; concrete errors extend it.
 *
 * ValidationError has a special implementation detail for the `field`
 * property to satisfy `useDefineForClassFields` semantics:
 *   - declared as `declare readonly field?: string`
 *   - assigned only when `field !== undefined`
 * so that `hasOwnProperty(instance, 'field')` is false when no field is given.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'validation.failed' as const;
  declare readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    if (field !== undefined) {
      this.field = field;
    }
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found' as const;
}

export class ConflictError extends DomainError {
  readonly code = 'conflict' as const;
}

export class ConfigurationError extends DomainError {
  readonly code = 'config.invalid' as const;
  declare readonly key?: string;

  constructor(message: string, key?: string) {
    super(message);
    if (key !== undefined) {
      this.key = key;
    }
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
