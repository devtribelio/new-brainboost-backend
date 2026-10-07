import { describe, expect, it } from 'vitest';
import { decideCodeAlias, type AliasInput } from '../src/code-aliases';

const WINNER = 'winner-uuid';
const OTHER = 'other-uuid';
const base: AliasInput = { code: 'ABCD1234', winnerMemberId: WINNER, codeMemberId: null, aliasMemberId: null, samePerson: true };

describe('decideCodeAlias', () => {
  it.each([
    ['free code, winner migrated → create', {}, { action: 'create' }],
    ['loser has no code → skip', { code: null }, { action: 'skip', reason: 'no_code' }],
    ['winner not in PG → skip', { winnerMemberId: undefined }, { action: 'skip', reason: 'no_winner' }],
    ['phone-only merge (not the same person) → skip, never aliased', { samePerson: false }, { action: 'skip', reason: 'not_same_person' }],
    ['code is the winner own code → skip', { codeMemberId: WINNER }, { action: 'skip', reason: 'winner_own_code' }],
    ['code owned by another member → collision', { codeMemberId: OTHER }, { action: 'collision', reason: 'held_by_member' }],
    ['alias already points at winner → skip (idempotent)', { aliasMemberId: WINNER }, { action: 'skip', reason: 'already_aliased' }],
    ['alias points at another member → collision', { aliasMemberId: OTHER }, { action: 'collision', reason: 'aliased_to_other' }],
    [
      'member code wins over an alias when both exist',
      { codeMemberId: OTHER, aliasMemberId: WINNER },
      { action: 'collision', reason: 'held_by_member' },
    ],
  ] as const)('%s', (_name, override, expected) => {
    expect(decideCodeAlias({ ...base, ...override })).toEqual(expected);
  });
});
