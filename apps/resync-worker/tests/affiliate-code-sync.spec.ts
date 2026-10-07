import { describe, expect, it } from 'vitest';
import { decideLegacyCode, type CodeState } from '../src/affiliate-code-sync';

const base: CodeState = { legacyCode: 'LEG123', memberId: 'm1', memberCode: null, holderId: null, aliasOwnerId: null };

describe('decideLegacyCode', () => {
  it.each([
    ['no legacy code → none', { legacyCode: null }, 'none'],
    ['member has no code → set', {}, 'set'],
    ['member already has another code → alias, never replace a shared link', { memberCode: 'APP999' }, 'alias'],
    ['code is already the member own code → same', { memberCode: 'LEG123', holderId: 'm1' }, 'same'],
    ['code held by another member → collision', { holderId: 'm2' }, 'collision'],
    ['code aliased to this member already → same', { memberCode: 'APP999', aliasOwnerId: 'm1' }, 'same'],
    ['code aliased to another member → collision', { aliasOwnerId: 'm2' }, 'collision'],
  ] as const)('%s', (_name, override, expected) => {
    expect(decideLegacyCode({ ...base, ...override })).toBe(expected);
  });
});
