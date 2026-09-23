import type { Request } from 'express';

/**
 * Client provenance from the `x-platform` header.
 *
 * Accepts a bare platform (`ios`) or a platform + build (`android/3.3.1+412`).
 * The build matters: without it a report of "streak broke after the update" cannot
 * be checked against the data at all, which is exactly what happened in Aug 2026.
 *
 * Anything else becomes null rather than being stored — the tracker's `source` also
 * carries synthetic markers (`backfill:*`, `goodwill:*`) that must never be forgeable
 * from a request header.
 */
export const SOURCE_PATTERN = /^(ios|android)(\/[\w.+-]{1,32})?$/;

export function platformFrom(req: Request): string | null {
  const raw = req.headers['x-platform'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && SOURCE_PATTERN.test(value) ? value : null;
}

/** Split a validated `platformFrom` value into its two audit columns. */
export function splitPlatform(source: string | null): {
  platform: string | null;
  appVersion: string | null;
} {
  if (!source) return { platform: null, appVersion: null };
  const [platform, appVersion] = source.split('/', 2);
  return { platform, appVersion: appVersion ?? null };
}
