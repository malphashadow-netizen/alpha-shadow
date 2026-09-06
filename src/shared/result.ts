/**
 * Result<T,E> — discriminated union for expected, recoverable failures.
 *
 * Use Result for outcomes a caller is expected to handle (validation, not found).
 * Use thrown errors only for programmer faults and infrastructure failures.
 */

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type Err<E> = {
  readonly ok: false;
  readonly error: E;
};

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (result.ok) {
    return result;
  }
  return err(fn(result.error));
}

export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}
