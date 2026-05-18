import { Xendit } from 'xendit-node';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

let cached: Xendit | null = null;

export function getXenditClient(): Xendit {
  if (cached) return cached;
  if (!env.xendit.secretKey) {
    throw new Error('XENDIT_SECRET_KEY not configured');
  }
  cached = new Xendit({ secretKey: env.xendit.secretKey });
  logger.debug('[xendit] SDK client initialized');
  return cached;
}

export function resetXenditClient(): void {
  cached = null;
}
