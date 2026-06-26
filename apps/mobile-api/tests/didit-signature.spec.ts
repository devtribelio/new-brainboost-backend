/**
 * Didit webhook signature verification (pure crypto, no I/O).
 * Webhook secret comes from tests/setup.ts (DIDIT_WEBHOOK_SECRET).
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyDiditWebhookSignature,
  DIDIT_TIMESTAMP_TOLERANCE_SEC,
} from '@bb/common/services/didit-signature';

const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET!;
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function signOf(body: Buffer, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyDiditWebhookSignature', () => {
  const body = Buffer.from(JSON.stringify({ status: 'Approved', session_id: 's1' }));

  it('accepts a valid HMAC-SHA256 signature within the timestamp window', () => {
    expect(verifyDiditWebhookSignature(body, signOf(body), String(NOW_SEC), NOW_MS)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ status: 'Approved', session_id: 's2' }));
    expect(verifyDiditWebhookSignature(tampered, signOf(body), String(NOW_SEC), NOW_MS)).toBe(false);
  });

  it('rejects a wrong signature', () => {
    expect(verifyDiditWebhookSignature(body, 'deadbeef', String(NOW_SEC), NOW_MS)).toBe(false);
  });

  it('rejects a stale timestamp (replay outside the window)', () => {
    const stale = String(NOW_SEC - DIDIT_TIMESTAMP_TOLERANCE_SEC - 1);
    expect(verifyDiditWebhookSignature(body, signOf(body), stale, NOW_MS)).toBe(false);
  });

  it('accepts a timestamp at the edge of the window', () => {
    const edge = String(NOW_SEC - DIDIT_TIMESTAMP_TOLERANCE_SEC);
    expect(verifyDiditWebhookSignature(body, signOf(body), edge, NOW_MS)).toBe(true);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifyDiditWebhookSignature(body, signOf(body), 'not-a-ts', NOW_MS)).toBe(false);
  });

  it('fails closed on missing signature, body, or timestamp', () => {
    expect(verifyDiditWebhookSignature(body, undefined, String(NOW_SEC), NOW_MS)).toBe(false);
    expect(verifyDiditWebhookSignature(undefined, signOf(body), String(NOW_SEC), NOW_MS)).toBe(false);
    expect(verifyDiditWebhookSignature(body, signOf(body), undefined, NOW_MS)).toBe(false);
  });
});
