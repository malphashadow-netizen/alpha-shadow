import { describe, expect, it } from 'vitest';

import { snapshotForAudit } from '../../../src/shared/audit-snapshot.ts';

describe('snapshotForAudit — central sensitive-field redaction', () => {
  it('omits password_hash and pin_hash together from a users row', () => {
    const snapshot = snapshotForAudit({
      id: 'user-1',
      email: 'cashier@example.test',
      password_hash: 'password-digest',
      pin_hash: 'pin-digest',
      is_active: true,
    });

    expect(snapshot).toEqual({ id: 'user-1', email: 'cashier@example.test', is_active: true });
    expect(JSON.stringify(snapshot)).not.toContain('password_hash');
    expect(JSON.stringify(snapshot)).not.toContain('pin_hash');
    expect(JSON.stringify(snapshot)).not.toContain('password-digest');
    expect(JSON.stringify(snapshot)).not.toContain('pin-digest');
  });

  it('redacts suffix patterns and exact names recursively, including future fields', () => {
    const snapshot = snapshotForAudit({
      api_secret: 'a',
      session_pepper: 'c',
      signing_secret: 'd',
      password: 'e',
      pin: 'f',
      secret: 'g',
      nested: [{ refresh_hash: 'h', visible: 'kept' }],
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      amount_minor: 10n,
    });

    expect(snapshot).toEqual({
      nested: [{ visible: 'kept' }],
      created_at: '2026-01-01T00:00:00.000Z',
      amount_minor: '10',
    });
  });

  it('does not mutate the source row', () => {
    const row = { password_hash: 'hidden', profile: { display_name: 'A' } };
    const snapshot = snapshotForAudit(row);
    expect(row).toEqual({ password_hash: 'hidden', profile: { display_name: 'A' } });
    expect(snapshot).toEqual({ profile: { display_name: 'A' } });
  });
});
