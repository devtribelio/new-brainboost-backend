import { describe, it, expect } from 'vitest';
import {
  signEventOrderToken,
  verifyEventOrderToken,
} from '@bb/common/utils/event-order-token.util';

const CODE = 'BB-20260910-0042';

describe('event order token', () => {
  it('round-trips the order code it was minted for', () => {
    expect(verifyEventOrderToken(signEventOrderToken(CODE))).toEqual({ code: CODE });
  });

  it('refuses an expired token', () => {
    expect(verifyEventOrderToken(signEventOrderToken(CODE, -1))).toBeNull();
  });

  it('refuses a tampered signature', () => {
    const token = signEventOrderToken(CODE);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyEventOrderToken(flipped)).toBeNull();
  });

  it('refuses a swapped code, even with a signature that is valid for another', () => {
    const [, exp, mac] = signEventOrderToken(CODE).split('.');
    const other = Buffer.from('BB-20260910-9999', 'utf8').toString('base64url');
    expect(verifyEventOrderToken(`${other}.${exp}.${mac}`)).toBeNull();
  });

  it('refuses garbage without throwing', () => {
    // The endpoint maps a bad token onto the same 404 as an unknown code, so this
    // must never raise — a 401 would tell a guesser the code exists.
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', '...', 'a.b.c']) {
      expect(verifyEventOrderToken(bad)).toBeNull();
    }
  });
});
