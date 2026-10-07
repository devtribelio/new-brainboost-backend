import { describe, expect, it } from 'vitest';
import { planAdopt, type AdoptExisting, type AdoptLegacy } from '../src/adopt-rules';

const existing = (over: Partial<AdoptExisting> = {}): AdoptExisting => ({
  email: null,
  phone: null,
  googleSub: null,
  appleSub: null,
  fullName: null,
  avatarUrl: null,
  bio: null,
  isActive: false,
  isEmailVerified: false,
  isPhoneVerified: false,
  bankAccountNumber: null,
  ...over,
});

const legacy = (over: Partial<AdoptLegacy> = {}): AdoptLegacy => ({
  email: null,
  phone: null,
  phoneCode: null,
  googleSub: null,
  appleSub: null,
  fullName: null,
  avatarUrl: null,
  bio: null,
  isActive: false,
  isEmailVerified: false,
  isPhoneVerified: false,
  bank: null,
  ...over,
});

describe('planAdopt', () => {
  it('never downgrades the placeholder: app profile wins, only empties are filled', () => {
    const data = planAdopt(
      existing({
        email: 'a@x.com',
        googleSub: 'g1',
        fullName: 'App Name',
        isActive: true,
        isEmailVerified: true,
      }),
      legacy({
        email: 'a@x.com',
        phone: '+628123456',
        phoneCode: '+62',
        googleSub: 'g1',
        fullName: 'Legacy Name',
        avatarUrl: 'https://img',
        bio: 'hi',
        isActive: false, // legacy inactive must NOT deactivate the app member
        isEmailVerified: true,
        isPhoneVerified: true,
        bank: { bankCode: 'BCA' },
      }),
    );
    expect(data.fullName).toBeUndefined(); // existing non-empty wins
    expect(data.isActive).toBeUndefined(); // never lowered
    expect(data.email).toBeUndefined();
    expect(data.phone).toBe('+628123456'); // placeholder had none
    expect(data.phoneCode).toBe('+62');
    expect(data.isPhoneVerified).toBe(true);
    expect(data.avatarUrl).toBe('https://img');
    expect(data.bio).toBe('hi');
    expect(data.bankCode).toBe('BCA'); // placeholder had no account
  });

  it('raises activation/verification when the placeholder lacked it', () => {
    const data = planAdopt(
      existing({ email: 'a@x.com' }),
      legacy({ email: 'a@x.com', isActive: true, isEmailVerified: true }),
    );
    expect(data.isActive).toBe(true);
    expect(data.isEmailVerified).toBe(true);
  });

  it('does not carry legacy email-verification onto a different placeholder email', () => {
    // matched on the Google subject, but the emails differ
    const data = planAdopt(
      existing({ email: 'app@x.com', googleSub: 'g1' }),
      legacy({ email: 'legacy@x.com', googleSub: 'g1', isEmailVerified: true }),
    );
    expect(data.email).toBeUndefined();
    expect(data.isEmailVerified).toBeUndefined();
  });

  it('keeps an app-set bank account', () => {
    const data = planAdopt(
      existing({ bankAccountNumber: '123' }),
      legacy({ bank: { bankCode: 'MANDIRI', bankAccountNumber: '999' } }),
    );
    expect(data.bankCode).toBeUndefined();
    expect(data.bankAccountNumber).toBeUndefined();
  });
});
