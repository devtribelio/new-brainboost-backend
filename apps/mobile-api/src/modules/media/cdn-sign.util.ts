import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

/** `env.media.cdn` shape — also what tests hand in directly. */
export interface CdnSigningConfig {
  host: string;
  keyPairId: string;
  privateKey: string;
}

/** Only this prefix has a CloudFront behavior that trusts the key group. */
export const CDN_SIGNED_PREFIX = 'private/audio/';

export function isCdnConfigured(c: CdnSigningConfig): boolean {
  return Boolean(c.host && c.keyPairId && c.privateKey);
}

/**
 * CloudFront signed URL (canned policy) for one object, valid `ttlSeconds` from
 * `now`. Query carries `Expires`, `Signature`, `Key-Pair-Id`; CloudFront checks
 * them before touching its cache and never forwards them to S3. Unlike an S3
 * presigned GET this covers HEAD too, and the object is served from the edge.
 */
export function signCdnUrl(
  c: CdnSigningConfig,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return getSignedUrl({
    url: `https://${c.host}/${path}`,
    keyPairId: c.keyPairId,
    privateKey: c.privateKey,
    dateLessThan: new Date(now + ttlSeconds * 1000).toISOString(),
  });
}
