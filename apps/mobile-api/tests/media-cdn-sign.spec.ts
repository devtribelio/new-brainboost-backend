import { describe, it, expect } from 'vitest';
import { createVerify, generateKeyPairSync } from 'crypto';
import { isCdnConfigured, signCdnUrl } from '../src/modules/media/cdn-sign.util';
import { MediaService } from '../src/modules/media/media.service';

/**
 * Pure tests — no DB, no network. Verifies the CloudFront canned-policy
 * signature against the public key the way CloudFront itself does, so a
 * broken signer fails here rather than as a 403 on a POCO.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cdn = {
  host: 'cdn-test.example.com',
  keyPairId: 'KTESTKEYPAIR',
  privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
};

/** CloudFront's base64 variant: `+` → `-`, `=` → `_`, `/` → `~`. */
function fromCloudFrontBase64(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
}

describe('signCdnUrl', () => {
  it('signs https://<host>/<key> with Expires, Key-Pair-Id and a valid RSA-SHA1 signature', () => {
    const now = 1_800_000_000_000;
    const url = new URL(signCdnUrl(cdn, 'private/audio/g1/2/000.ts', 3600, now));

    expect(url.origin).toBe('https://cdn-test.example.com');
    expect(url.pathname).toBe('/private/audio/g1/2/000.ts');
    expect(url.searchParams.get('Key-Pair-Id')).toBe('KTESTKEYPAIR');
    const expires = Number(url.searchParams.get('Expires'));
    expect(expires).toBe(now / 1000 + 3600);

    const policy = JSON.stringify({
      Statement: [
        {
          Resource: `https://cdn-test.example.com/private/audio/g1/2/000.ts`,
          Condition: { DateLessThan: { 'AWS:EpochTime': expires } },
        },
      ],
    });
    const verifier = createVerify('RSA-SHA1').update(policy);
    const ok = verifier.verify(publicKey, fromCloudFrontBase64(url.searchParams.get('Signature')!));
    expect(ok).toBe(true);
  });

  it('is not configured while any of host / key pair id / private key is empty', () => {
    expect(isCdnConfigured(cdn)).toBe(true);
    expect(isCdnConfigured({ ...cdn, host: '' })).toBe(false);
    expect(isCdnConfigured({ ...cdn, keyPairId: '' })).toBe(false);
    expect(isCdnConfigured({ ...cdn, privateKey: '' })).toBe(false);
  });
});

describe('MediaService.buildAudioPlaylist signer selection', () => {
  const fakeStorage = {
    getPresignedGetUrl: async (key: string) => `https://s3.example/${key}?X-Amz-Signature=s3`,
  } as unknown as ConstructorParameters<typeof MediaService>[0];

  it('uses CloudFront for private/audio/* parts when the CDN is configured', async () => {
    const svc = new MediaService(fakeStorage, cdn);
    const body = await svc.buildAudioPlaylist({
      guid: 'g1',
      audioKey: 'private/audio/g1/2/',
      durationSec: 1000,
      segments: [
        { key: 'private/audio/g1/2/000.ts', durationSec: 500 },
        { key: 'private/audio/g1/2/001.ts', durationSec: 500 },
      ],
    });
    expect(body.match(/https:\/\/cdn-test\.example\.com\/private\/audio\/g1\/2\/00[01]\.ts\?/g)).toHaveLength(2);
    expect(body).toContain('Key-Pair-Id=KTESTKEYPAIR');
    expect(body).not.toContain('X-Amz-Signature');
  });

  it('falls back to S3 presign when the CDN is not configured', async () => {
    const svc = new MediaService(fakeStorage, { host: '', keyPairId: '', privateKey: '' });
    const body = await svc.buildAudioPlaylist({
      guid: 'g1',
      audioKey: 'private/audio/g1/2/',
      durationSec: 1000,
      segments: [{ key: 'private/audio/g1/2/000.ts', durationSec: 1000 }],
    });
    expect(body).toContain('https://s3.example/private/audio/g1/2/000.ts?X-Amz-Signature=s3');
  });

  // A single-file row from before the prefix convention: no CDN behavior covers
  // `audio/…`, so the CDN would answer 403 — S3 must keep serving it.
  it('keeps S3 presign for a key outside private/audio/ even with the CDN configured', async () => {
    const svc = new MediaService(fakeStorage, cdn);
    const body = await svc.buildAudioPlaylist({
      guid: 'g1',
      audioKey: 'audio/g1/1.aac',
      durationSec: 3123,
      segments: [],
    });
    expect(body).toContain('https://s3.example/audio/g1/1.aac?X-Amz-Signature=s3');
  });
});
