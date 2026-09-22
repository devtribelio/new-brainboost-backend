import { describe, it, expect } from 'vitest';
import { parseHlsParts, segmentSeconds } from '../src/modules/media/audio-migration.util';

/** Pure tests — the job itself needs ffmpeg, Bunny and S3, so it is verified on staging. */

describe('segmentSeconds', () => {
  it.each([
    [3123, 12, 261],
    [3676, 12, 307],
    [3600, 12, 300],
    [10, 12, 1],
    [3123, 1, 3123],
    [3677, 120, 31],
    [3755, 120, 32],
  ])('%is into %i parts → %is per part', (duration, parts, expected) => {
    expect(segmentSeconds(duration, parts)).toBe(expected);
  });

  // The property the whole split depends on: never more segments than asked,
  // even though ffmpeg makes every segment a little LONGER than hls_time.
  it('never yields more than `parts` segments', () => {
    for (const duration of [59, 600, 3123, 3676, 7201]) {
      for (const parts of [1, 8, 12, 120, 200]) {
        expect(Math.ceil(duration / segmentSeconds(duration, parts))).toBeLessThanOrEqual(parts);
      }
    }
  });

  it('rejects nonsense', () => {
    expect(() => segmentSeconds(0, 12)).toThrow();
    expect(() => segmentSeconds(100, 0)).toThrow();
  });
});

describe('parseHlsParts', () => {
  const m3u8 = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:326', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:325.013333,', '000.ts',
    '#EXTINF:324.992000,', '001.ts',
    '#EXTINF:101.013333,', '002.ts',
    '#EXT-X-ENDLIST', '',
  ].join('\n');

  it('returns the parts in play order with durations rounded to ms', () => {
    expect(parseHlsParts(m3u8)).toEqual([
      { file: '000.ts', durationSec: 325.013 },
      { file: '001.ts', durationSec: 324.992 },
      { file: '002.ts', durationSec: 101.013 },
    ]);
  });

  it('refuses a segment with no duration', () => {
    expect(() => parseHlsParts('#EXTM3U\n000.ts\n')).toThrow();
  });
});
