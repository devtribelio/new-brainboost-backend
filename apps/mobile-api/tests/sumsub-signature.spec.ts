/**
 * Sumsub request signing + webhook digest verification (pure crypto, no I/O).
 * Webhook secret comes from tests/setup.ts (SUMSUB_WEBHOOK_SECRET).
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  signSumsubRequest,
  verifySumsubWebhookDigest,
} from '@bb/common/services/sumsub-signature';

const WEBHOOK_SECRET = process.env.SUMSUB_WEBHOOK_SECRET!;

function digestOf(body: Buffer, alg = 'sha256', secret = WEBHOOK_SECRET): string {
  return createHmac(alg, secret).update(body).digest('hex');
}

describe('signSumsubRequest', () => {
  it('produces HMAC-SHA256 hex over ts + METHOD + path + body', () => {
    const sig = signSumsubRequest('secret', 1700000000, 'post', '/resources/applicants?levelName=x', '{"a":1}');
    const expected = createHmac('sha256', 'secret')
      .update('1700000000POST/resources/applicants?levelName=x{"a":1}')
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('treats a missing body as empty string', () => {
    const withEmpty = signSumsubRequest('secret', 1, 'GET', '/x', '');
    const withUndefined = signSumsubRequest('secret', 1, 'GET', '/x');
    expect(withUndefined).toBe(withEmpty);
  });
});

describe('verifySumsubWebhookDigest', () => {
  const body = Buffer.from(JSON.stringify({ type: 'applicantReviewed', applicantId: 'a1' }));

  it('accepts a valid sha256 digest (default alg)', () => {
    expect(verifySumsubWebhookDigest(body, digestOf(body), 'HMAC_SHA256_HEX')).toBe(true);
  });

  it('defaults to sha256 when the alg header is absent', () => {
    expect(verifySumsubWebhookDigest(body, digestOf(body), undefined)).toBe(true);
  });

  it('accepts sha512 when announced', () => {
    expect(verifySumsubWebhookDigest(body, digestOf(body, 'sha512'), 'HMAC_SHA512_HEX')).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ type: 'applicantReviewed', applicantId: 'a2' }));
    expect(verifySumsubWebhookDigest(tampered, digestOf(body), 'HMAC_SHA256_HEX')).toBe(false);
  });

  it('rejects a wrong digest', () => {
    expect(verifySumsubWebhookDigest(body, 'deadbeef', 'HMAC_SHA256_HEX')).toBe(false);
  });

  it('rejects an unknown algorithm header', () => {
    expect(verifySumsubWebhookDigest(body, digestOf(body), 'HMAC_MD5_HEX')).toBe(false);
  });

  it('fails closed on missing digest or body', () => {
    expect(verifySumsubWebhookDigest(body, undefined, 'HMAC_SHA256_HEX')).toBe(false);
    expect(verifySumsubWebhookDigest(undefined, digestOf(body), 'HMAC_SHA256_HEX')).toBe(false);
  });
});
