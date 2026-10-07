import { describe, expect, it } from 'vitest';
import { markReason, markSkip, skipReasonsSummary } from '../src/util';
import { emptyStats } from '../src/types';

describe('markSkip / markReason', () => {
  it('markSkip increments skipped and records the reason + a sample pk', () => {
    const stats = emptyStats();
    markSkip(stats, 'course_not_mapped', 123);
    markSkip(stats, 'course_not_mapped', 124);
    markSkip(stats, 'member_unresolved', 9);
    expect(stats.skipped).toBe(3);
    expect(stats.skipReasons).toEqual({ course_not_mapped: 2, member_unresolved: 1 });
    expect(stats.skipSamples?.course_not_mapped).toEqual([123, 124]);
  });

  it('markReason counts a reason without touching skipped (the tree double-count fix)', () => {
    const stats = emptyStats();
    markReason(stats, 'inviter_unresolved_parent', 424829);
    expect(stats.skipped).toBe(0);
    expect(stats.skipReasons).toEqual({ inviter_unresolved_parent: 1 });
  });

  it('adds `count` for aggregates (superseded rows) and skips non-positive counts', () => {
    const stats = emptyStats();
    markReason(stats, 'superseded_row', null, 7);
    markSkip(stats, 'subject_not_migrated', null, 0);
    expect(stats.skipReasons).toEqual({ superseded_row: 7 });
    expect(stats.skipped).toBe(0);
  });

  it('caps samples at 5 and adds none for a null pk', () => {
    const stats = emptyStats();
    for (let i = 0; i < 8; i += 1) markSkip(stats, 'unique_clash', i);
    markSkip(stats, 'other', null);
    expect(stats.skipSamples?.unique_clash).toEqual([0, 1, 2, 3, 4]);
    expect(stats.skipSamples?.other).toBeUndefined();
  });

  it('summary is empty without reasons and sorted by count otherwise', () => {
    expect(skipReasonsSummary(emptyStats())).toBe('');
    const stats = emptyStats();
    markSkip(stats, 'a', 1);
    markSkip(stats, 'b', 2);
    markSkip(stats, 'b', 3);
    expect(skipReasonsSummary(stats)).toBe(' skip[b=2 a=1]');
  });
});
