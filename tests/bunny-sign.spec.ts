import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signBunnyUrl, signBunnyHlsUrl } from '../src/modules/media/bunny-sign.util';

/**
 * Unit tests for Bunny CDN URL token signing (Model C).
 *
 * Verifies the official HMAC-SHA256 / `HS256-` scheme. The *correctness against
 * the live Bunny CDN* is a manual probe step — see docs/media-model-c-migration.md §8.
 */
describe('bunny-sign', () => {
  describe('signBunnyUrl', () => {
    it('produces the official HMAC-SHA256 HS256- directory token', () => {
      const key = 'sec-key';
      const expiresAt = 1_800_000_000;
      const url = signBunnyUrl('https://vz-x.b-cdn.net/g/playlist.m3u8', key, {
        expiresAt,
        isDirectory: true,
        pathAllowed: '/g/',
      });
      // message = signaturePath + expires + signingData
      const message = `/g/${expiresAt}token_path=/g/`;
      const expectedToken =
        'HS256-' +
        createHmac('sha256', key)
          .update(message)
          .digest('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      expect(url).toBe(
        `https://vz-x.b-cdn.net/bcdn_token=${expectedToken}&token_path=%2Fg%2F&expires=${expiresAt}/g/playlist.m3u8`,
      );
    });

    it('is deterministic for a fixed expiresAt', () => {
      const opts = { expiresAt: 123, isDirectory: true, pathAllowed: '/g/' } as const;
      const a = signBunnyUrl('https://h.b-cdn.net/g/playlist.m3u8', 'k', opts);
      const b = signBunnyUrl('https://h.b-cdn.net/g/playlist.m3u8', 'k', opts);
      expect(a).toBe(b);
    });

    it('changes when the key changes', () => {
      const a = signBunnyUrl('https://h.b-cdn.net/g/p.m3u8', 'k1', { expiresAt: 123 });
      const b = signBunnyUrl('https://h.b-cdn.net/g/p.m3u8', 'k2', { expiresAt: 123 });
      expect(a).not.toBe(b);
    });

    it('query mode puts the HS256- token in the query string', () => {
      const url = signBunnyUrl('https://h.b-cdn.net/g/p.m3u8', 'k', {
        expiresAt: 123,
        isDirectory: false,
      });
      expect(url).toBe('https://h.b-cdn.net/g/p.m3u8?token=' + new URL(url).searchParams.get('token') + '&expires=123');
      const token = new URL(url).searchParams.get('token') ?? '';
      expect(token.startsWith('HS256-')).toBe(true);
      expect(token.slice(6)).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('signBunnyHlsUrl', () => {
    it('builds a path-embedded directory token URL for the guid', () => {
      const url = signBunnyHlsUrl('vid-1');
      expect(url).toContain('/bcdn_token=HS256-');
      expect(url).toContain('token_path=%2Fvid-1%2F');
      expect(url).toMatch(/&expires=\d+/);
      expect(url.endsWith('/vid-1/playlist.m3u8')).toBe(true);
    });

    it('honours an explicit ttl', () => {
      const url = signBunnyHlsUrl('g', { ttlSeconds: 60 });
      const expires = Number(url.match(/&expires=(\d+)/)?.[1]);
      const now = Math.floor(Date.now() / 1000);
      expect(expires).toBeGreaterThan(now);
      expect(expires).toBeLessThanOrEqual(now + 61);
    });
  });
});
