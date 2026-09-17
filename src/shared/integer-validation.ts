import { ValidationError } from './errors.ts';

export function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`, field);
  }
}

export function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, field);
  }
}
