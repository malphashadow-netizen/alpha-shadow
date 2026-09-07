/**
 * Data-driven availability windows.
 *
 * No opening hours, meal periods, or time zones are written in this module.
 * Every window, day-of-week index, clock time and IANA zone comes from the
 * JSONB stored on `branch_menu_item_overrides.availability_schedule`.
 * A missing/empty schedule means "no restriction".
 */
import { ValidationError } from '../../../shared/errors.ts';

export interface AvailabilityWindow {
  readonly daysOfWeek?: readonly number[];
  readonly start?: string;
  readonly end?: string;
}

export interface AvailabilitySchedule {
  readonly timeZone?: string;
  readonly windows?: readonly AvailabilityWindow[];
}

const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseClockToMinutes(value: string, field: string): number {
  const match = TIME_PATTERN.exec(value);
  if (match === null) {
    throw new ValidationError(`${field} must be HH:MM or HH:MM:SS`, field);
  }
  const hourText = match[1];
  const minuteText = match[2];
  const secondText = match[3];
  if (hourText === undefined || minuteText === undefined) {
    throw new ValidationError(`${field} must be HH:MM or HH:MM:SS`, field);
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new ValidationError(`${field} is not a valid clock time`, field);
  }
  return hour * 60 + minute;
}

function weekdayIndexFromParts(parts: readonly Intl.DateTimeFormatPart[]): number {
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  // Calendar mapping (JS Date convention), not a business-hours table.
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (weekday === undefined || index[weekday] === undefined) {
    throw new ValidationError('availability schedule produced an unknown weekday', 'availabilitySchedule');
  }
  return index[weekday];
}

function minutesFromParts(parts: readonly Intl.DateTimeFormatPart[]): number {
  const hourText = parts.find((part) => part.type === 'hour')?.value;
  const minuteText = parts.find((part) => part.type === 'minute')?.value;
  if (hourText === undefined || minuteText === undefined) {
    throw new ValidationError('availability schedule could not resolve a local time', 'availabilitySchedule');
  }
  return Number(hourText) * 60 + Number(minuteText);
}

function zonedClock(at: Date, timeZone: string): { readonly weekday: number; readonly minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    throw new ValidationError(`unknown time zone in availability schedule: "${timeZone}"`, 'timeZone');
  }
  return { weekday: weekdayIndexFromParts(parts), minutes: minutesFromParts(parts) };
}

function windowMatches(window: AvailabilityWindow, clock: { readonly weekday: number; readonly minutes: number }): boolean {
  const days = window.daysOfWeek;
  if (days !== undefined && days.length > 0 && !days.includes(clock.weekday)) {
    return false;
  }
  if (window.start === undefined && window.end === undefined) {
    return true;
  }
  const start = window.start === undefined ? 0 : parseClockToMinutes(window.start, 'start');
  const end = window.end === undefined ? 24 * 60 : parseClockToMinutes(window.end, 'end');
  if (start <= end) {
    return clock.minutes >= start && clock.minutes < end;
  }
  // Overnight window (data-defined): e.g. 22:00 → 02:00.
  return clock.minutes >= start || clock.minutes < end;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerces stored JSONB into a schedule. Unknown extra keys are ignored so a
 * future schedule shape can land as data without an engine change. Invalid
 * types fail closed.
 */
export function parseAvailabilitySchedule(value: unknown): AvailabilitySchedule | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new ValidationError('availability_schedule must be a JSON object', 'availabilitySchedule');
  }
  const timeZone = value['timeZone'];
  const windowsRaw = value['windows'];
  const schedule: {
    timeZone?: string;
    windows?: AvailabilityWindow[];
  } = {};
  if (timeZone !== undefined) {
    if (typeof timeZone !== 'string' || timeZone.trim() === '') {
      throw new ValidationError('availability_schedule.timeZone must be a non-empty string', 'timeZone');
    }
    schedule.timeZone = timeZone;
  }
  if (windowsRaw !== undefined) {
    if (!Array.isArray(windowsRaw)) {
      throw new ValidationError('availability_schedule.windows must be an array', 'windows');
    }
    const windows: AvailabilityWindow[] = [];
    for (const entry of windowsRaw) {
      if (!isPlainObject(entry)) {
        throw new ValidationError('availability_schedule.windows entries must be objects', 'windows');
      }
      const window: {
        daysOfWeek?: number[];
        start?: string;
        end?: string;
      } = {};
      if (entry['daysOfWeek'] !== undefined) {
        if (!Array.isArray(entry['daysOfWeek']) || entry['daysOfWeek'].some((day) => !Number.isInteger(day))) {
          throw new ValidationError('daysOfWeek must be an array of integers', 'daysOfWeek');
        }
        window.daysOfWeek = entry['daysOfWeek'] as number[];
      }
      if (entry['start'] !== undefined) {
        if (typeof entry['start'] !== 'string') {
          throw new ValidationError('window start must be a string', 'start');
        }
        window.start = entry['start'];
      }
      if (entry['end'] !== undefined) {
        if (typeof entry['end'] !== 'string') {
          throw new ValidationError('window end must be a string', 'end');
        }
        window.end = entry['end'];
      }
      windows.push(window);
    }
    schedule.windows = windows;
  }
  return schedule;
}

export function isWithinAvailabilitySchedule(schedule: AvailabilitySchedule | null, at: Date, fallbackTimeZone: string): boolean {
  if (schedule === null) return true;
  const windows = schedule.windows;
  if (windows === undefined || windows.length === 0) return true;
  const timeZone = schedule.timeZone ?? fallbackTimeZone;
  const clock = zonedClock(at, timeZone);
  return windows.some((window) => windowMatches(window, clock));
}
