import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { clientIp } from '@bb/common/middlewares/rate-limit.middleware';

// Regression guard for the Cloudflare -> nginx -> Node keying bug: with
// TRUST_PROXY=1 behind two hops, req.ip is the rotating CF edge IP, so the
// limiter must key on CF-Connecting-IP (the real visitor) instead.
function req(headers: Record<string, unknown>, ip?: string): Pick<Request, 'headers' | 'ip'> {
  return { headers, ip } as unknown as Pick<Request, 'headers' | 'ip'>;
}

describe('rate-limit clientIp', () => {
  it('prefers CF-Connecting-IP over req.ip (the CF edge)', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }, '162.158.1.1'))).toBe('203.0.113.7');
  });

  it('trims whitespace on the header value', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '  203.0.113.7  ' }, '162.158.1.1'))).toBe(
      '203.0.113.7',
    );
  });

  it('takes the first entry when the header arrives as an array', () => {
    expect(
      clientIp(req({ 'cf-connecting-ip': ['203.0.113.7', '203.0.113.8'] }, '162.158.1.1')),
    ).toBe('203.0.113.7');
  });

  it('falls back to req.ip when CF-Connecting-IP is absent (dev/LAN/health)', () => {
    expect(clientIp(req({}, '10.0.0.5'))).toBe('10.0.0.5');
  });

  it('falls back to req.ip when the header is empty', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '   ' }, '10.0.0.5'))).toBe('10.0.0.5');
  });

  it('returns a stable sentinel when neither is available', () => {
    expect(clientIp(req({}, undefined))).toBe('anonymous');
  });
});
