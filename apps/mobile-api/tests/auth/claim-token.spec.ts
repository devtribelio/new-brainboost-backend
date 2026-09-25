import { describe, it, expect } from 'vitest';
import { signClaimToken, verifyClaimToken } from '@bb/common/utils/claim-token.util';

const MEMBER_ID = '11111111-2222-3333-4444-555555555555';

describe('claim account token', () => {
  it('round-trips the member id it was minted for', () => {
    expect(verifyClaimToken(signClaimToken(MEMBER_ID))).toEqual({ memberId: MEMBER_ID });
  });

  it('refuses an expired token', () => {
    expect(verifyClaimToken(signClaimToken(MEMBER_ID, -1))).toBeNull();
  });

  it('refuses a tampered signature', () => {
    const token = signClaimToken(MEMBER_ID);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyClaimToken(flipped)).toBeNull();
  });

  it('refuses a swapped member id, even with a signature valid for another', () => {
    const [, exp, mac] = signClaimToken(MEMBER_ID).split('.');
    const other = Buffer.from('99999999-8888-7777-6666-555555555555', 'utf8').toString('base64url');
    expect(verifyClaimToken(`${other}.${exp}.${mac}`)).toBeNull();
  });

  it('refuses garbage without throwing', () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', '...', 'a.b.c']) {
      expect(verifyClaimToken(bad)).toBeNull();
    }
  });
});
