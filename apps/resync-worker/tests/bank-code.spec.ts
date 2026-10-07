import { describe, expect, it } from 'vitest';
import { normalizeBankCode } from '../src/bank-code';

describe('normalizeBankCode', () => {
  it.each([
    ['bca', 'BCA'],
    ['mandiri', 'MANDIRI'],
    ['mandiri-syariah', 'BSI'],
    ['Mandiri-Syariah', 'BSI'],
    ['bankbtn', 'BTN'],
    ['standard-chartered', 'STANDARD_CHARTERED'],
    ['  bni ', 'BNI'],
    ['BRI', 'BRI'],
    ['unknownbank', 'UNKNOWNBANK'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ] as const)('%s → %s', (raw, expected) => {
    expect(normalizeBankCode(raw)).toBe(expected);
  });
});
