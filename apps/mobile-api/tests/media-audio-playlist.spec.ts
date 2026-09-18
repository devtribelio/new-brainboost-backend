import { describe, it, expect } from 'vitest';
import { renderSingleSegmentPlaylist, renderPlaylist } from '../src/modules/media/audio-playlist.util';
import {
  signMediaToken,
  verifyMediaToken,
  signAudioPlaylistToken,
  verifyAudioPlaylistToken,
  signDocumentToken,
} from '../src/modules/media/media-token.util';

/**
 * Pure tests — no DB, no app. The integration half (route wiring, DB row,
 * presigned segment URL) lives in `media-audio-source.spec.ts`.
 */

describe('renderSingleSegmentPlaylist', () => {
  it('emits a valid one-segment VOD media playlist', () => {
    const body = renderSingleSegmentPlaylist({
      segmentUrl: 'https://cdn.example/audio/g1/1.aac?X-Amz-Signature=abc',
      durationSec: 3123,
    });
    const lines = body.split('\n');

    expect(lines[0]).toBe('#EXTM3U');
    expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(body).toContain('#EXT-X-TARGETDURATION:3123');
    expect(body).toContain('#EXTINF:3123.0,');
    expect(body).toContain('https://cdn.example/audio/g1/1.aac?X-Amz-Signature=abc');
    // Exactly one segment: one EXTINF, the URL right after it, then ENDLIST.
    expect(body.match(/#EXTINF/g)).toHaveLength(1);
    const extinfAt = lines.findIndex((l) => l.startsWith('#EXTINF'));
    expect(lines[extinfAt + 1]).toContain('.aac');
    expect(lines[extinfAt + 2]).toBe('#EXT-X-ENDLIST');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('renders several segments in order, target = longest rounded, EXTINF keeps fractions', () => {
    const body = renderPlaylist([
      { url: 'https://s/000.ts?sig=a', durationSec: 480.021 },
      { url: 'https://s/001.ts?sig=b', durationSec: 479.979 },
      { url: 'https://s/002.ts?sig=c', durationSec: 120 },
    ]);
    const lines = body.split('\n');
    expect(body).toContain('#EXT-X-TARGETDURATION:480');
    expect(body.match(/#EXTINF/g)).toHaveLength(3);
    expect(lines.indexOf('https://s/000.ts?sig=a')).toBeLessThan(lines.indexOf('https://s/001.ts?sig=b'));
    expect(body).toContain('#EXTINF:480.021,');
    expect(body).toContain('#EXTINF:120.0,');
    expect(lines[lines.length - 2]).toBe('#EXT-X-ENDLIST');
  });

  it('refuses an empty segment list', () => {
    expect(() => renderPlaylist([])).toThrow();
  });

  it('never emits a zero target duration, and rounds fractional input', () => {
    expect(renderSingleSegmentPlaylist({ segmentUrl: 'x', durationSec: 0 })).toContain(
      '#EXT-X-TARGETDURATION:1',
    );
    expect(renderSingleSegmentPlaylist({ segmentUrl: 'x', durationSec: 59.6 })).toContain(
      '#EXT-X-TARGETDURATION:60',
    );
  });
});

describe('audio-playlist token', () => {
  const payload = { guid: 'guid-a', courseId: 'course-a', isPreview: false, forDownload: true };

  it('round-trips its payload, including the download flag', () => {
    const token = signAudioPlaylistToken(payload, 60);
    expect(verifyAudioPlaylistToken(token)).toEqual(payload);
  });

  it('defaults forDownload to false when absent', () => {
    const token = signAudioPlaylistToken({ ...payload, forDownload: false }, 60);
    expect(verifyAudioPlaylistToken(token).forDownload).toBe(false);
  });

  // The playlist token is handed out AFTER the /hls access gate and travels
  // with no bearer. If /stream, /download or /hls accepted it, it would let a
  // caller skip that gate on those endpoints.
  it('is rejected by verifyMediaToken', () => {
    const token = signAudioPlaylistToken(payload, 60);
    expect(() => verifyMediaToken(token)).toThrow();
  });

  it('does not accept a media token or a document token in its place', () => {
    const media = signMediaToken({ guid: 'guid-a', courseId: 'course-a', isPreview: false });
    const doc = signDocumentToken({ key: 'private/x.pdf', courseId: 'course-a', isPreview: false });
    expect(() => verifyAudioPlaylistToken(media)).toThrow();
    expect(() => verifyAudioPlaylistToken(doc)).toThrow();
  });

  it('expires', () => {
    const token = signAudioPlaylistToken(payload, -1);
    expect(() => verifyAudioPlaylistToken(token)).toThrow();
  });
});
