import { describe, it, expect } from 'vitest';
import {
  compareSemver,
  isWithinVersionWindow,
  parseVersion,
  resolveVerdict,
} from '@/modules/app-version/version.util';

describe('compareSemver', () => {
  const cases: Array<[string, string, -1 | 0 | 1 | null]> = [
    ['3.2.2', '3.2.3', -1],
    ['3.2.3', '3.2.3', 0],
    ['3.2.4', '3.2.3', 1],
    // The case a string compare gets wrong: '3.10.0' < '3.9.9' lexicographically.
    ['3.10.0', '3.9.9', 1],
    ['3.9.9', '3.10.0', -1],
    ['4.0.0', '3.99.99', 1],
    // Missing trailing segments are zero, so these are equal.
    ['3.2', '3.2.0', 0],
    ['3', '3.0.0', 0],
    // Pre-release/build suffixes are dropped — we gate on the release triple only.
    ['3.3.0-beta.1', '3.3.0', 0],
    ['3.3.0+42', '3.3.0', 0],
    ['v3.3.0', '3.3.0', null],
    ['', '3.3.0', null],
    ['nonsense', '3.3.0', null],
  ];

  it.each(cases)('compare(%s, %s) === %s', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});

describe('parseVersion', () => {
  it('rejects non-version input', () => {
    expect(parseVersion('v1.0.0')).toBeNull();
    expect(parseVersion('1.0.0.beta')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseVersion(' 1.2.3 ')).toEqual([1, 2, 3]);
  });
});

describe('resolveVerdict', () => {
  const config = { latestVersion: '3.3.0', forceBelow: '3.2.0' };

  it.each([
    ['3.1.5', 'force'],
    ['3.1.99', 'force'],
    // Exactly on the force threshold: not forced (strict <), still nagged.
    ['3.2.0', 'soft'],
    ['3.2.9', 'soft'],
    // Exactly on latest: nothing.
    ['3.3.0', 'none'],
    // Ahead of latest (internal/TestFlight build): left alone.
    ['3.4.0', 'none'],
  ])('%s → %s', (version, expected) => {
    expect(resolveVerdict(version, config)).toBe(expected);
  });

  it('never forces when forceBelow is null', () => {
    expect(resolveVerdict('1.0.0', { latestVersion: '3.3.0', forceBelow: null })).toBe('soft');
    expect(resolveVerdict('3.3.0', { latestVersion: '3.3.0', forceBelow: null })).toBe('none');
  });

  it('treats an unparseable installed version as none, never as force', () => {
    expect(resolveVerdict('v3.1.0', config)).toBe('none');
    expect(resolveVerdict('', config)).toBe('none');
  });
});

describe('isWithinVersionWindow', () => {
  const cases: Array<[string | undefined, string | null, string | null, boolean]> = [
    // No bound: always inside, even with no version.
    [undefined, null, null, true],
    ['3.3.0', '', '  ', true],
    // Both bounds inclusive.
    ['3.3.2', '3.3.2', '3.4.0', true],
    ['3.4.0', '3.3.2', '3.4.0', true],
    ['3.3.1', '3.3.2', '3.4.0', false],
    ['3.4.1', '3.3.2', '3.4.0', false],
    // One-sided.
    ['9.9.9', '3.3.2', null, true],
    ['1.0.0', null, '3.4.0', true],
    // Numeric, not lexicographic.
    ['3.10.0', '3.3.2', '3.9.0', false],
    // Fails closed once a bound is set.
    [undefined, '3.3.2', null, false],
    ['nightly', null, '3.4.0', false],
    ['3.3.2', 'garbage', null, false],
  ];
  it.each(cases)('version=%s min=%s max=%s -> %s', (version, min, max, expected) => {
    expect(isWithinVersionWindow(version, min, max)).toBe(expected);
  });
});
