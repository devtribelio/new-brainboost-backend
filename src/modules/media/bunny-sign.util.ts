import crypto from 'node:crypto';
import { env } from '@/config/env';

/**
 * Bunny CDN URL Token Authentication — signed playback URLs (Model C).
 *
 * Algorithm ported from the official `BunnyWay/BunnyCDN.TokenAuthentication`
 * implementation (`nodejs/token.js`):
 *
 *   message = signaturePath + expires + signingData            (userIp omitted)
 *   token   = "HS256-" + base64url( HMAC-SHA256(securityKey, message) )
 *
 * `signingData` is the query parameters sorted by key and joined `k=v` with `&`
 * (raw values). `token_path` (the directory scope) is itself a signed parameter.
 *
 * The Model C Stream library has Token Authentication enabled — an unsigned CDN
 * URL is `403`. The backend signs after the access check; the client streams
 * directly from the Bunny edge.
 */

export interface SignBunnyUrlOptions {
  /** Token lifetime in seconds (ignored when `expiresAt` is given). */
  expirationSeconds?: number;
  /** Absolute expiry, unix seconds. Overrides `expirationSeconds` — used by tests. */
  expiresAt?: number;
  /** `true` embeds the token in the path (`/bcdn_token=…`); `false` uses `?token=`. */
  isDirectory?: boolean;
  /** Restrict the token to a path prefix (a directory like `/{guid}/`). */
  pathAllowed?: string;
}

/** URL-safe base64, no padding (Bunny token charset). */
function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign an arbitrary Bunny CDN URL. Pure — the security key is passed in.
 */
export function signBunnyUrl(
  url: string,
  securityKey: string,
  opts: SignBunnyUrlOptions = {},
): string {
  const { expirationSeconds = 3600, expiresAt, isDirectory = false, pathAllowed = '' } = opts;

  const parsed = new URL(url);
  const expires = String(expiresAt ?? Math.floor(Date.now() / 1000) + expirationSeconds);

  const parameters: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) parameters[key] = value;
  if (pathAllowed) parameters.token_path = pathAllowed;

  const sorted = Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b));
  const signaturePath = pathAllowed || parsed.pathname;
  const signingData = sorted.map(([k, v]) => `${k}=${v}`).join('&');
  const urlData = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const message = `${signaturePath}${expires}${signingData}`;
  const digest = crypto.createHmac('sha256', securityKey).update(message).digest();
  const token = `HS256-${base64Url(digest)}`;

  const base = `${parsed.protocol}//${parsed.host}`;
  const tail = urlData ? `&${urlData}` : '';
  return isDirectory
    ? `${base}/bcdn_token=${token}${tail}&expires=${expires}${parsed.pathname}`
    : `${base}${parsed.pathname}?token=${token}${tail}&expires=${expires}`;
}

/**
 * Build a signed HLS playlist URL for a Bunny Stream video `guid`.
 *
 * Uses the path-embedded directory token (`/bcdn_token=…/`) scoped to `/{guid}/`
 * so the HLS `.ts` segments — fetched as paths relative to the playlist — inherit
 * the token automatically.
 */
export function signBunnyHlsUrl(guid: string, opts: { ttlSeconds?: number } = {}): string {
  const fileUrl = `https://${env.bunny.streamCdnHost}/${guid}/playlist.m3u8`;
  return signBunnyUrl(fileUrl, env.bunny.streamTokenKey, {
    expirationSeconds: opts.ttlSeconds ?? env.media.signedUrlTtlSeconds,
    isDirectory: true,
    pathAllowed: `/${guid}/`,
  });
}
