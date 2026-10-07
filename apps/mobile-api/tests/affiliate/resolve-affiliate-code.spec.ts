import { describe, expect, it } from 'vitest';
import { isAffiliateCodeFree, resolveAffiliateCode } from '@bb/domain/affiliate/resolve-affiliate-code';

// In-memory stand-in for the two tables — this spec pins the lookup ORDER only; the
// real-DB behaviour is covered through the call sites' integration specs.
function fakeDb(members: { id: string; affiliateCode: string | null }[], aliases: Record<string, string>) {
  const db = {
    member: {
      findUnique: async ({ where }: any) =>
        members.find((m) => (where.id ? m.id === where.id : m.affiliateCode === where.affiliateCode)) ?? null,
    },
    memberAffiliateCodeAlias: {
      findUnique: async ({ where }: any) =>
        aliases[where.code] ? { code: where.code, memberId: aliases[where.code] } : null,
    },
  };
  return db as any;
}

const db = fakeDb(
  [
    { id: 'winner', affiliateCode: 'WIN00001' },
    { id: 'other', affiliateCode: 'OTH00001' },
  ],
  { LOSE0001: 'winner', OTH00001: 'winner', DEAD0001: 'deleted-member' },
);

describe('resolveAffiliateCode', () => {
  it.each([
    ["member's own code → that member", 'WIN00001', 'winner'],
    ['alias code → the member it points at', 'LOSE0001', 'winner'],
    ["member's own code wins over an alias with the same code", 'OTH00001', 'other'],
    ['unknown code → null', 'NOPE0001', null],
    ['alias to a member that no longer exists → null', 'DEAD0001', null],
    ['empty code → null', '', null],
  ])('%s', async (_name, code, expected) => {
    const m = await resolveAffiliateCode(code, { id: true }, db);
    expect(m?.id ?? null).toBe(expected);
  });
});

describe('isAffiliateCodeFree', () => {
  it.each([
    ['taken by a member', 'WIN00001', false],
    ['taken by an alias', 'LOSE0001', false],
    ['unused', 'FREE0001', true],
  ])('%s', async (_name, code, expected) => {
    expect(await isAffiliateCodeFree(code, db)).toBe(expected);
  });
});
