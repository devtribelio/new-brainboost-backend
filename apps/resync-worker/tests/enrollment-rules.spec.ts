import { describe, expect, it } from 'vitest';
import {
  decideEnrollmentWrite,
  mayCancelRemoved,
  LEGACY_CANCEL_REASON,
  LEGACY_PAYMENT_REVOKED_REASON,
  type ExistingEnrollment,
} from '../src/syncers/enrollment-rules';

const NOW = new Date('2026-10-05T00:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');
const FUTURE = new Date('2026-11-01T00:00:00Z');

const row = (o: Partial<ExistingEnrollment>): ExistingEnrollment => ({
  id: 'e1',
  legacyId: 100,
  isCanceled: false,
  cancelationReason: null,
  expiredDate: null,
  progress: 0,
  ...o,
});

describe('decideEnrollmentWrite', () => {
  it.each([
    ['no row for the pair → create', undefined, 'create'],
    ['same legacyId, live → refresh', row({}), 'refresh'],
    [
      'same legacyId reactivated after legacy_removed → uncancel',
      row({ isCanceled: true, cancelationReason: LEGACY_CANCEL_REASON }),
      'uncancel',
    ],
    [
      'same legacyId re-granted after a payment revoke → uncancel',
      row({ isCanceled: true, cancelationReason: LEGACY_PAYMENT_REVOKED_REASON }),
      'uncancel',
    ],
    [
      'same legacyId, refund-cancelled → refresh, stays cancelled',
      row({ isCanceled: true, cancelationReason: 'refund' }),
      'refresh',
    ],
    ['re-enroll after expired trial → repoint', row({ legacyId: 99, expiredDate: PAST }), 'repoint'],
    [
      're-enroll when old row cancelled → repoint',
      row({ legacyId: 99, isCanceled: true, cancelationReason: LEGACY_CANCEL_REASON }),
      'repoint',
    ],
    ['other legacyId, live trial, incoming paid → repoint', row({ legacyId: 99, expiredDate: FUTURE }), 'repoint'],
    ['other legacyId, live paid → skip', row({ legacyId: 99 }), 'skip'],
    ['new-system row → skip', row({ legacyId: null }), 'skip'],
    ['new-system row, cancelled → skip', row({ legacyId: null, isCanceled: true }), 'skip'],
    ['employee grant (no legacy id, expired) → skip', row({ legacyId: null, expiredDate: PAST }), 'skip'],
  ] as const)('%s', (_name, existing, expected) => {
    expect(decideEnrollmentWrite(existing, 100, NOW)).toBe(expected);
  });

  it.each([
    ['paid re-enrol over a LIVE trial → repoint', row({ legacyId: 99, expiredDate: FUTURE }), null, 'repoint'],
    ['new live trial over a live trial → skip', row({ legacyId: 99, expiredDate: FUTURE }), FUTURE, 'skip'],
    ['live paid row, incoming trial → skip', row({ legacyId: 99 }), FUTURE, 'skip'],
    ['new-system trial, incoming paid → skip', row({ legacyId: null, expiredDate: FUTURE }), null, 'skip'],
  ] as const)('%s', (_name, existing, incomingExpired, expected) => {
    expect(decideEnrollmentWrite(existing, 100, NOW, incomingExpired)).toBe(expected);
  });

  it.each([
    ['refund-cancelled, incoming paid re-purchase → repoint', 'refund', true, 'repoint'],
    ['refund-cancelled, incoming free grant → skip', 'refund', false, 'skip'],
    ['legacy_removed, incoming free grant → repoint', LEGACY_CANCEL_REASON, false, 'repoint'],
  ] as const)('%s', (_name, reason, incomingPaid, expected) => {
    const existing = row({ legacyId: 99, isCanceled: true, cancelationReason: reason });
    expect(decideEnrollmentWrite(existing, 100, NOW, null, incomingPaid)).toBe(expected);
  });
});

describe('mayCancelRemoved', () => {
  const base = { existing: row({}), legacyId: 100, otherActiveLegacyRows: 0, hasPaidOrder: false };

  it.each([
    ['normal removal of our own row → cancel', base, true],
    ['no row for the pair → no', { ...base, existing: undefined }, false],
    ['pair held by another legacyId → no', { ...base, existing: row({ legacyId: 99 }) }, false],
    ['pair held by a new-system row → no', { ...base, existing: row({ legacyId: null }) }, false],
    ['blocked by another active legacy row for the pair', { ...base, otherActiveLegacyRows: 1 }, false],
    ['blocked by a PAID order in the new system', { ...base, hasPaidOrder: true }, false],
    ['already cancelled → no', { ...base, existing: row({ isCanceled: true }) }, false],
  ] as const)('%s', (_name, input, expected) => {
    expect(mayCancelRemoved(input)).toBe(expected);
  });
});
