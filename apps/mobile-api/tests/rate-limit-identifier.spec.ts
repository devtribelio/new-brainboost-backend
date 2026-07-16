import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { _keyers } from '@bb/common/middlewares/rate-limit.middleware';

const { byUsername, byMemberId, byTarget, byPhoneTarget, byRegisterTarget, byEmailOrPhone } =
  _keyers;

// Office/carrier NAT: many real users share one public IP. Credential limiters
// must key on the account identifier from the body, not the shared IP, or
// colleagues lock each other out. IP is only a fallback.
function req(body: Record<string, unknown>, ip = '1.2.3.4', cf?: string): Request {
  const headers: Record<string, unknown> = {};
  if (cf) headers['cf-connecting-ip'] = cf;
  return { body, ip, headers } as unknown as Request;
}

describe('rate-limit per-identifier keying', () => {
  it('keys login on username, case-insensitively and IP-independently', () => {
    const a = byUsername(req({ username: 'Alice@X.com' }, '1.1.1.1'));
    const b = byUsername(req({ username: 'alice@x.com' }, '9.9.9.9')); // diff IP, same user
    expect(a).toBe(b);
    expect(a.startsWith('username:')).toBe(true);
  });

  it('gives different usernames different buckets on the SAME office IP', () => {
    const office = '203.0.113.5';
    expect(byUsername(req({ username: 'alice' }, office))).not.toBe(
      byUsername(req({ username: 'bob' }, office)),
    );
  });

  it('falls back to the client IP when no identifier is present', () => {
    expect(byUsername(req({}, '203.0.113.9'))).toBe('ip:203.0.113.9');
  });

  it('IP fallback prefers CF-Connecting-IP over req.ip', () => {
    expect(byUsername(req({}, '162.158.1.1', '203.0.113.9'))).toBe('ip:203.0.113.9');
  });

  it('kind-isolates: same text as a target vs a memberId never collide', () => {
    expect(byTarget(req({ target: 'same' }))).not.toBe(byMemberId(req({ memberId: 'same' })));
  });

  it('canonicalizes phone register (0811 / +62 vs 8111 / 62 collapse to one bucket)', () => {
    const k1 = byPhoneTarget(req({ phone: '08111', phoneCode: '+62' }));
    const k2 = byPhoneTarget(req({ phone: '8111', phoneCode: '62' }));
    expect(k1).toBe(k2);
    expect(k1.startsWith('phone:')).toBe(true);
  });

  it('register keys on username, else the phone target', () => {
    expect(byRegisterTarget(req({ username: 'jane' }))).toBe(
      byRegisterTarget(req({ username: 'JANE' })),
    );
    expect(byRegisterTarget(req({ phone: '08111', phoneCode: '62' })).startsWith('register:')).toBe(
      true,
    );
  });

  it('forgot-password prefers email, else a digits-normalized phone', () => {
    expect(byEmailOrPhone(req({ email: 'A@b.com' }))).toBe(byEmailOrPhone(req({ email: 'a@b.com' })));
    expect(byEmailOrPhone(req({ phone: '0811-222' }))).toBe(
      byEmailOrPhone(req({ phone: '0811222' })),
    );
  });

  it('memberId keys are stable, IP-independent, and hashed (no raw id leak)', () => {
    const k = byMemberId(req({ memberId: 'uuid-123' }, '1.1.1.1'));
    expect(k).toBe(byMemberId(req({ memberId: 'uuid-123' }, '9.9.9.9')));
    expect(k).not.toContain('uuid-123');
  });

  it('trims surrounding whitespace so " alice " and "alice" share a bucket', () => {
    expect(byUsername(req({ username: '  alice  ' }))).toBe(byUsername(req({ username: 'alice' })));
  });

  it('treats a whitespace-only / empty identifier as absent → IP fallback', () => {
    expect(byUsername(req({ username: '   ' }, '203.0.113.7'))).toBe('ip:203.0.113.7');
    expect(byUsername(req({ username: '' }, '203.0.113.7'))).toBe('ip:203.0.113.7');
    expect(byMemberId(req({ memberId: undefined }, '203.0.113.7'))).toBe('ip:203.0.113.7');
  });
});
