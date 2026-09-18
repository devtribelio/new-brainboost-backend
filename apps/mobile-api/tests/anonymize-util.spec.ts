import { describe, it, expect } from 'vitest';
import {
  anonymizeEmail,
  anonymizePhone,
  anonymizeUsername,
  maskEmail,
  maskPhone,
  maskUsername,
} from '@bb/common/utils/anonymize.util';

const ID_A = '0192f3a1-1111-7000-8000-000000000001';
const ID_B = '0192f3a1-2222-7000-8000-000000000002';

describe('maskEmail', () => {
  it.each([
    ['budi@gmail.com', 'b***@gmail.com'],
    ['a@gmail.com', 'a***@gmail.com'],
    ['first.last@sub.domain.co.id', 'f***@sub.domain.co.id'],
    // Multiple '@' — the LAST one separates the domain, so the extra stays masked.
    ['we@ird@gmail.com', 'w***@gmail.com'],
  ])('masks the local part of %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it.each(['notanemail', '@leading', 'trailing@'])(
    'masks %s whole when it is not an address shape',
    (input) => {
      const out = maskEmail(input);
      expect(out).toBe(`${input.slice(0, 1)}***`);
      expect(out).not.toContain(input.slice(1));
    },
  );
});

describe('maskPhone', () => {
  it('keeps head and tail but never a dialable middle', () => {
    expect(maskPhone('81234567890')).toBe('8123****890');
  });

  it.each(['1', '1234'])('blanks %s entirely when too short to mask safely', (input) => {
    expect(maskPhone(input)).toBe('****');
  });

  it('keeps a single digit each side for mid-length values', () => {
    expect(maskPhone('8123456')).toBe('8****6');
  });
});

describe('maskUsername', () => {
  it('keeps two leading characters', () => {
    expect(maskUsername('budianto')).toBe('bu***');
  });
});

describe('anonymize* — uniqueness is what makes the purge safe', () => {
  it('prefixes with the member id, so two rows can never collide', () => {
    // The failure this prevents: a fixed prefix would make the SECOND deletion of
    // the same address violate the unique index (P2002). jobs-runner swallows
    // per-job errors, so that row would silently never be purged.
    expect(anonymizeEmail(ID_A, 'budi@gmail.com')).not.toBe(
      anonymizeEmail(ID_B, 'budi@gmail.com'),
    );
  });

  it('produces a value that is not a deliverable address', () => {
    const out = anonymizeEmail(ID_A, 'budi@gmail.com')!;
    expect(out).toBe(`del:${ID_A}:b***@gmail.com`);
    // Colons in the local part — if an outbound path ever fails to filter deleted
    // members it fails validation instead of mailing a live domain.
    expect(out.slice(0, out.lastIndexOf('@'))).toContain(':');
  });

  it('does not double-prefix on a re-run', () => {
    const once = anonymizeEmail(ID_A, 'budi@gmail.com')!;
    expect(anonymizeEmail(ID_A, once)).toBe(once);
  });

  it('leaves absent values as null — nothing to free, nothing to record', () => {
    expect(anonymizeEmail(ID_A, null)).toBeNull();
    expect(anonymizePhone(ID_A, null)).toBeNull();
    expect(anonymizeUsername(ID_A, null)).toBeNull();
  });

  it('never leaks the original value', () => {
    expect(anonymizePhone(ID_A, '81234567890')).not.toContain('4567');
    expect(anonymizeUsername(ID_A, 'budianto')).not.toContain('dianto');
  });
});
