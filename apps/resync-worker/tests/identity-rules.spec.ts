import { describe, expect, it } from 'vitest';
import {
  decideIdentityMatch,
  type ExistingMember,
  type IdentityDecision,
  type IdentityKeys,
} from '../src/identity-rules';

const LEGACY_ID = 100;
const none: IdentityKeys = { email: null, phone: null, googleSub: null, appleSub: null };
const legacy: IdentityKeys = { email: 'a@x.id', phone: '8111111111', googleSub: 'g-1', appleSub: 'ap-1' };
const winner = (keys: Partial<IdentityKeys>, legacyId: number | null = 7): ExistingMember => ({
  ...none,
  ...keys,
  legacyId,
});

describe('decideIdentityMatch', () => {
  const cases: Array<[string, IdentityKeys, ExistingMember | null, IdentityDecision]> = [
    ['no collision creates', legacy, null, 'create'],
    ['the row already carries this legacy id maps', legacy, winner({ phone: '8111111111' }, LEGACY_ID), 'map'],
    // strong keys keep the old behaviour
    ['same email + winner redirects', legacy, winner({ email: 'a@x.id' }), 'redirect'],
    ['same email + phone + winner redirects', legacy, winner({ email: 'a@x.id', phone: '8111111111' }), 'redirect'],
    ['same googleSub, different email redirects', legacy, winner({ email: 'b@x.id', googleSub: 'g-1' }), 'redirect'],
    ['same appleSub redirects', legacy, winner({ appleSub: 'ap-1' }), 'redirect'],
    ['same email + placeholder adopts', legacy, winner({ email: 'a@x.id' }, null), 'adopt'],
    ['same googleSub + placeholder adopts', legacy, winner({ googleSub: 'g-1', phone: '8111111111' }, null), 'adopt'],
    // phone-only: never merged
    ['phone only, emails differ: separate', legacy, winner({ email: 'b@x.id', phone: '8111111111' }), 'separate_without_phone'],
    ['phone only, existing has no email: separate', legacy, winner({ phone: '8111111111' }), 'separate_without_phone'],
    [
      'phone only, legacy has no email: separate',
      { ...legacy, email: null },
      winner({ email: 'b@x.id', phone: '8111111111' }),
      'separate_without_phone',
    ],
    [
      'phone only, neither side has email: separate',
      { ...none, phone: '8111111111' },
      winner({ phone: '8111111111' }),
      'separate_without_phone',
    ],
    [
      'phone only with a new-app placeholder: separate, not adopt',
      legacy,
      winner({ email: 'b@x.id', phone: '8111111111' }, null),
      'separate_without_phone',
    ],
    [
      'different provider subs do not count as a match',
      { ...legacy, email: null },
      winner({ phone: '8111111111', googleSub: 'g-2' }),
      'separate_without_phone',
    ],
    ['two nulls never match', { ...none, phone: '8111111111' }, winner({ email: null, phone: '8222222222' }), 'create'],
  ];

  it.each(cases)('%s', (_name, legacyKeys, existing, expected) => {
    expect(decideIdentityMatch(LEGACY_ID, legacyKeys, existing)).toBe(expected);
  });
});
