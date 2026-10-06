import { describe, expect, it } from 'vitest';
import { normalizeLegacyPhonePair, otpPhoneTarget } from '@bb/common/utils/phone.util';

describe('normalizeLegacyPhonePair', () => {
  it('preserves a foreign dial code the legacy value already carries', () => {
    expect(normalizeLegacyPhonePair('+2787861310426')).toEqual({ phoneCode: '+27', phone: '87861310426' });
    expect(normalizeLegacyPhonePair('+852 1234 5678')).toEqual({ phoneCode: '+852', phone: '12345678' });
    expect(normalizeLegacyPhonePair('+12025550123')).toEqual({ phoneCode: '+1', phone: '2025550123' });
  });

  it('keeps the OTP target intact after the split', () => {
    const pair = normalizeLegacyPhonePair('+2787861310426')!;
    expect(otpPhoneTarget(pair.phoneCode, pair.phone)).toBe('+2787861310426');
  });

  it('still canonicalizes Indonesian numbers through normalizePhonePair', () => {
    expect(normalizeLegacyPhonePair('+628111111111')).toEqual({ phoneCode: '+62', phone: '8111111111' });
    expect(normalizeLegacyPhonePair('08111111111')).toEqual({ phoneCode: '+62', phone: '8111111111' });
    expect(normalizeLegacyPhonePair('8111111111')).toEqual({ phoneCode: '+62', phone: '8111111111' });
  });

  it('returns null for an empty value', () => {
    expect(normalizeLegacyPhonePair('')).toBeNull();
    expect(normalizeLegacyPhonePair('   ')).toBeNull();
  });

  it('falls back to the default code when the + prefix is not a known dial code', () => {
    // '+857…' is not a real calling code → keep the old default behaviour rather than guess
    expect(normalizeLegacyPhonePair('+8571234567')).toEqual({ phoneCode: '+62', phone: '8571234567' });
  });
});
