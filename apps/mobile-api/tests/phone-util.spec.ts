import { describe, it, expect } from 'vitest';
import { sanitizePhone, isValidPhone, toMsisdn } from '@bb/common/utils/phone.util';

describe('sanitizePhone (legacy TBUtils::sanitizePhone parity)', () => {
  const cases: Array<[string, string]> = [
    ['08111111111', '+628111111111'], // leading 0 -> +62, drop 0
    ['628111111111', '+628111111111'], // already prefix -> add +
    ['+628111111111', '+628111111111'], // already E.164 -> unchanged
    ['8111111111', '+628111111111'], // bare national -> prepend +62
    ['', ''], // empty stays empty
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(sanitizePhone(input)).toBe(expected);
  });
});

describe('isValidPhone', () => {
  it('accepts a normal Indonesian mobile', () => {
    expect(isValidPhone('08111111111')).toBe(true);
    expect(isValidPhone('+628111111111')).toBe(true);
  });
  it('rejects too-short numbers', () => {
    expect(isValidPhone('123')).toBe(false); // -> +62123, 5 digits
    expect(isValidPhone('+1')).toBe(false);
  });
  it('rejects garbage', () => {
    expect(isValidPhone('not-a-phone')).toBe(false);
  });
});

describe('toMsisdn', () => {
  it('returns digits only (Qontak form)', () => {
    expect(toMsisdn('+62 811-111-1111')).toBe('628111111111');
    expect(toMsisdn('08111111111')).toBe('628111111111');
  });
});
