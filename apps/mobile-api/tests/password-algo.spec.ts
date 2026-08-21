import { describe, expect, it } from 'vitest';
import { detectPasswordAlgo } from '@bb/common/utils/password-algo.util';

describe('detectPasswordAlgo', () => {
  it.each([
    ['$2y$10$BPshS0000000000000000000000000000000000000000000000000', 'bcrypt'],
    ['$2a$12$abcdefghijklmnopqrstuv', 'bcrypt'],
    ['$2b$10$abcdefghijklmnopqrstuv', 'bcrypt'],
    ['5f4dcc3b5aa765d61d8327deb882cf99', 'legacy'], // md5
    ['5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8', 'sha1'],
    ['5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', 'sha256'],
  ])('%s -> %s', (hash, expected) => {
    expect(detectPasswordAlgo(hash)).toBe(expected);
  });

  it('treats a missing password as social-only', () => {
    expect(detectPasswordAlgo(null)).toBe('social');
    expect(detectPasswordAlgo(undefined)).toBe('social');
    expect(detectPasswordAlgo('')).toBe('social');
  });

  it('falls back to legacy for an unrecognised shape', () => {
    // the social sentinel (two uuids) keeps its dashes → not hex → never bcrypt/sha
    expect(detectPasswordAlgo('0198d0f2-1111-7000-8000-000000000000x')).toBe('legacy');
  });
});
