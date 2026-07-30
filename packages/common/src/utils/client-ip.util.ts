import type { Request } from 'express';

// Real client IP, used for rate-limit keying and access logging.
//
// The deployed chain is Cloudflare -> nginx (proxy_pass 127.0.0.1) -> Node, i.e.
// TWO proxy hops, but the app runs with TRUST_PROXY=1 (trusts nginx only). Express
// therefore resolves `req.ip` to the ROTATING Cloudflare edge IP, not the visitor,
// so per-IP buckets scatter across CF's edge fleet and the limiter never fills
// (verified: 60 login attempts, zero 429s). Cloudflare always sets CF-Connecting-IP
// to the real client and strips any client-supplied copy, so it is the reliable key
// regardless of hop count. Fall back to req.ip for non-CF traffic (dev, LAN, health).
//
// SECURITY NOTE: CF-Connecting-IP is only trustworthy while traffic is forced
// through Cloudflare. The origin (nginx on 0.0.0.0:80/443) MUST be firewalled to
// Cloudflare's published IP ranges, otherwise an attacker reaching the origin
// directly can forge this header. See docs/security-audit-followups.md.
//
// Lives in its own file (not in rate-limit.middleware) so the request logger can
// use it without importing that module — importing it instantiates every
// rateLimit() bucket and, with REDIS_URL set, opens a Redis connection.
export function clientIp(req: Pick<Request, 'headers' | 'ip'>): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim() !== '') return cf.trim();
  if (Array.isArray(cf) && cf[0]) return cf[0].trim();
  return req.ip ?? 'anonymous';
}
