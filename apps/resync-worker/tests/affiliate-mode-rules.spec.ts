import { describe, expect, it } from 'vitest';
import { AFFILIATE_BASED_SOURCE, mayOverwriteAffiliateBased } from '../src/syncers/affiliate-mode-rules';

describe('mayOverwriteAffiliateBased', () => {
  it('owns an unknown source (NULL)', () => {
    expect(mayOverwriteAffiliateBased(null)).toBe(true);
  });

  it('owns a legacy-sourced mode', () => {
    expect(mayOverwriteAffiliateBased(AFFILIATE_BASED_SOURCE.LEGACY)).toBe(true);
  });

  it('never touches a mode the member set in the app', () => {
    expect(mayOverwriteAffiliateBased(AFFILIATE_BASED_SOURCE.APP)).toBe(false);
  });

  it('never touches an unrecognised source', () => {
    expect(mayOverwriteAffiliateBased('SOMETHING_ELSE')).toBe(false);
  });
});
