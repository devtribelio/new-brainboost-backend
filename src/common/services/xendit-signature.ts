import { randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';

export function verifyXenditCallbackToken(headerValue: string | undefined): boolean {
  const expected = env.xendit.callbackToken;
  if (!expected || !headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function generateExternalId(prefix = 'commerce'): string {
  return `${prefix}-${randomUUID()}`;
}
