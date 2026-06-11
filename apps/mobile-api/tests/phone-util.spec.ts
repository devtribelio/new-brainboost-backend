import { describe, it, expect } from 'vitest';
import {
  sanitizePhone,
  isValidPhone,
  toMsisdn,
  normalizeDialCode,
  normalizeNationalPhone,
  normalizePhonePair,
} from '@bb/common/utils/phone.util';

describe('sanitizePhone (legacy TBUtils::sanitizePhone parity)', () => {
  const cases: Array<[string, string]> = [
    ['08111111111', '+628111111111'], // leading 0 -> +62, drop 0
    ['628111111111', '+628111111111'], // already prefix -> add +
    ['+628111111111', '+628111111111'], // already E.164 -> unchanged
    ['8111111111', '+628111111111'], // bare national -> prepend +62
    ['+6208111111111', '+628111111111'], // defensive: dial code + national-with-0 -> drop the 0
    ['6208111111111', '+628111111111'], // country code + leading 0 -> drop the 0
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

describe('normalizeDialCode', () => {
  const cases: Array<[string, string]> = [
    ['62', '+62'],
    ['+62', '+62'],
    [' +62 ', '+62'],
    ['', ''],
    ['+', ''],
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(normalizeDialCode(input)).toBe(expected);
  });
});

describe('normalizeNationalPhone', () => {
  const cases: Array<[string, string]> = [
    ['08111111111', '8111111111'], // leading 0 dropped
    ['8111111111', '8111111111'], // already national
    ['0811-111-1111', '8111111111'], // separators stripped
    ['0008111111111', '8111111111'], // all leading zeros dropped
  ];
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(normalizeNationalPhone(input)).toBe(expected);
  });
});

describe('normalizePhonePair (sanitizePhone branch-order parity)', () => {
  const cases: Array<[string, string, string, string]> = [
    // [phone, phoneCode, expectedPhone, expectedCode]
    ['8111111111', '62', '8111111111', '+62'], // national + bare code
    ['08111111111', '+62', '8111111111', '+62'], // leading 0 dropped
    ['+628111111111', '+62', '8111111111', '+62'], // E.164 in phone field -> dial code stripped
    ['628111111111', '62', '8111111111', '+62'], // 0-less + code-prefixed -> stripped
    ['0622123456', '+62', '622123456', '+62'], // leading 0 marks national: 622 area code KEPT
    ['8111111111', '', '8111111111', ''], // no code: phone still canonicalized
  ];
  it.each(cases)('(%s, %s) -> (%s, %s)', (phone, code, expPhone, expCode) => {
    expect(normalizePhonePair(phone, code)).toEqual({ phone: expPhone, phoneCode: expCode });
  });
});
