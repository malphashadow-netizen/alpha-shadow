import { describe, expect, it } from 'vitest';

import {
  isWithinAvailabilitySchedule,
  parseAvailabilitySchedule,
} from '../../../../src/application/engines/catalog/availability.ts';
import { ValidationError } from '../../../../src/shared/errors.ts';

describe('availability schedule — data-driven windows, no hardcoded hours', () => {
  it('treats null / empty windows as unrestricted', () => {
    const at = new Date('2026-03-04T12:00:00.000Z');
    expect(isWithinAvailabilitySchedule(null, at, 'UTC')).toBe(true);
    expect(isWithinAvailabilitySchedule({ windows: [] }, at, 'UTC')).toBe(true);
  });

  it('evaluates days and clock times from the stored payload', () => {
    // 2026-03-04 is a Wednesday (JS weekday 3). 15:30 UTC.
    const at = new Date('2026-03-04T15:30:00.000Z');
    const lunch = parseAvailabilitySchedule({
      timeZone: 'UTC',
      windows: [{ daysOfWeek: [3], start: '15:00', end: '16:00' }],
    });
    expect(isWithinAvailabilitySchedule(lunch, at, 'UTC')).toBe(true);

    const closed = parseAvailabilitySchedule({
      timeZone: 'UTC',
      windows: [{ daysOfWeek: [3], start: '08:00', end: '09:00' }],
    });
    expect(isWithinAvailabilitySchedule(closed, at, 'UTC')).toBe(false);
  });

  it('rejects a non-object schedule', () => {
    expect(() => parseAvailabilitySchedule(['08:00'])).toThrow(ValidationError);
    expect(() => parseAvailabilitySchedule('breakfast')).toThrow(ValidationError);
  });
});
