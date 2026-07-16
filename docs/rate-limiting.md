# Rate Limiting — Design

Throttling for abuse-prone, mostly-unauthenticated endpoints (login, register,
OTP, forgot-password) plus a couple of authenticated anti-enumeration limits
(voucher validate, media download).

- **Code:** `packages/common/src/middlewares/rate-limit.middleware.ts`
- **Startup probe:** `apps/mobile-api/src/core/startup-checks.ts`
- **Infra (prod store):** `infra/cdk/lib/bb-ecs-stack.ts` (ElastiCache)
- **Tests:** `apps/mobile-api/tests/rate-limit-*.spec.ts`
- **History:** `docs/security-audit-followups.md` (dated entries)

Built on [`express-rate-limit`](https://github.com/express-rate-limit/express-rate-limit) v7.

---

## 1. Three independent concerns

A rate limiter is defined by **what it counts (key)**, **where it counts (store)**,
and **for how long (window)**. Each was a separate problem here.

| Concern | Choice | Why |
|---|---|---|
| **Key** | account identifier from the body, IP as fallback | shared NAT (office / mobile carrier) would otherwise lock users out |
| **Store** | in-memory by default, Redis when `REDIS_URL` set | multi-instance deployments need one shared counter |
| **Window** | fixed 15-min window (60s for media) | simple, predictable; anchored at first hit |

---

## 2. Keying — per identifier, not per IP

### The problem with IP keying
Every request reaches the app through a proxy chain, and the "client IP" is
often **shared**:

- **Office WiFi / mobile carrier CGNAT** — thousands of real users behind **one**
  public IP. Keying on IP puts them all in one bucket, so one user's failed
  logins `429` everyone else. The 3-attempt OTP limiters are the worst case.
- **Cloudflare edge** — if trust-proxy is misconfigured, `req.ip` resolves to a
  *rotating* CF edge IP instead of the visitor (see §5), scattering the counter.

### The design
Credential limiters key on the **account identifier carried in the request body**,
normalized and hashed. IP is used **only as a fallback** when the body has no
usable identifier (malformed request, or a social/refresh login grant with no
username).

```
key = kind + ":" + sha256(kind + ":" + normalize(identifier))   // e.g. "username:Ab3f…"
    | "ip:" + clientIp(req)                                       // fallback only
```

- **normalize** — lowercase email/username, canonical `+62…` phone (via
  `otpPhoneTarget`), so casing/formatting can't spawn a fresh bucket.
- **hash** — raw emails/phones never land in Redis keys.
- **kind prefix** — namespaces identifier types so an email and a memberId with
  the same text can't collide.

> **IP is a fallback, never combined.** The key is *either* the identifier *or*
> the IP — not `id:ip`. A composite `id:ip` key would re-weaken targeted-attack
> protection (same victim across N IPs = N buckets = N× the OTP guesses). Where
> genuine per-IP protection is needed it is a *separate* layer (see §7), not a
> merged key.

### Security property
Keying per-identifier is **stricter** against a targeted attack than per-IP: an
OTP-guess budget is per *victim*, so an attacker rotating IPs cannot multiply the
number of guesses against one account.

### `clientIp()` — the fallback resolver
```
CF-Connecting-IP header (real client, set by Cloudflare) → req.ip → "anonymous"
```
Cloudflare always sets `CF-Connecting-IP` to the real visitor and strips any
client-supplied copy, so it is reliable **regardless of the trust-proxy hop
count** — which is why the fallback prefers it over `req.ip`.

---

## 3. Per-endpoint map

| Limiter (Redis prefix) | Limit / window | Key |
|---|---|---|
| `otp-validate` | 3 / 15m | `target` |
| `otp-validate-phone` | 3 / 15m | `memberId` |
| `otp-validate-email` | 3 / 15m | `memberId` |
| `forgot-verify` | 3 / 15m | `email` ?? `phone` |
| `forgot-request` | 10 / 15m | `email` ?? `phone` |
| `verify-request-phone` | 10 / 15m | `memberId` |
| `verify-request-email` | 10 / 15m | `memberId` |
| `register` | 15 / 15m | `username` ?? phone-target |
| `register-phone` | 15 / 15m | `otpPhoneTarget(phoneCode, phone)` |
| `login` | 30 / 15m | `username` (IP fallback), **failures only** |
| `voucher-validate` | 20 / 15m | `user.id` (authed) |
| `media-download` | 10 / 60s | `user.id` (authed) |

- **login** sets `skipSuccessfulRequests` — a successful login never spends
  budget, so only wrong-password attempts count.
- **voucher / media** are authenticated, so they key on `user.id` and are
  unaffected by shared IPs (IP is only their anonymous fallback).
- The tight 3/15m OTP limiters are the primary brute-force defense (guessing a
  6-digit code); login (30) is looser because humans mistype passwords.

Each limiter is its own `rateLimit()` instance with a distinct Redis prefix
(`rl:<name>:`), so spending one endpoint's budget never affects another.

---

## 4. Store — in-memory or shared Redis

`express-rate-limit`'s default store is **in-memory, per Node process**. That is
fine for a single process but breaks on a multi-instance deployment: each
instance keeps its own counter, so the effective limit becomes
`limit × instanceCount` and resets on every deploy.

The store is therefore **gated on `REDIS_URL`**:

| `REDIS_URL` | Store | Used by |
|---|---|---|
| unset | in-memory `MemoryStore` (per process) | local dev, single-process PM2 staging |
| set | `rate-limit-redis` + `ioredis`, one shared counter | multi-instance ECS |

- **Lazy client** — the Redis client is never constructed when `REDIS_URL` is
  unset, so single-process deployments pay nothing.
- **Fail-open wrapper (`FailOpenStore`)** — if Redis is unreachable, requests are
  *allowed* rather than 500'd. A limiter outage must degrade to "no throttling",
  never "auth is down". `ioredis` uses bounded retries so a dead Redis rejects
  fast instead of hanging the request.
- **Prefix per limiter** — `rl:<name>:` keeps buckets independent (MemoryStore
  got this for free by being a fresh instance per limiter).

### Startup probe
`checkRedisConnection()` runs in `runStartupChecks` as a **non-fatal** target:

- `REDIS_URL` unset → `skipped` (never connects).
- reachable → `[startup] redis connection ok`.
- configured but down → logged, **non-fatal**, boot continues.

It is deliberately non-fatal: since the store fails open, blocking boot on Redis
would turn graceful degradation into a full outage. The connection monitor logs
`redis` connect/disconnect transitions after boot.

---

## 5. Deployment topology

### Staging — single process behind Cloudflare
```
client → Cloudflare → nginx (proxy_pass 127.0.0.1:3000) → Node (PM2 fork, 1 instance)
```
- **Two proxy hops** (CF + nginx) but `TRUST_PROXY=1`. Keying on `req.ip` alone
  would resolve to the rotating Cloudflare edge IP — which is exactly why the
  fallback prefers `CF-Connecting-IP`.
- Single process → in-memory store is sufficient; `REDIS_URL` optional.
- **Origin firewall requirement:** `CF-Connecting-IP` is only trustworthy while
  traffic is forced through Cloudflare. The origin (nginx on `0.0.0.0:80/443`)
  **must** be restricted to Cloudflare's IP ranges (or fronted by a Cloudflare
  Tunnel), else an attacker hitting the origin directly can forge the header.

### Production — ECS, multiple tasks
```
client → (Cloudflare?) → ALB → Fargate tasks (2–6, autoscaled)
```
- Multiple tasks → **must** use the shared Redis store. The CDK provisions an
  ElastiCache `cache.t4g.micro` (SG-locked to the app) and injects `REDIS_URL`
  into the task env automatically.
- If Cloudflare fronts the ALB, the same `CF-Connecting-IP` keying + origin
  lockdown (ALB SG → CF ranges) applies.

---

## 6. Window / TTL

Fixed window, anchored at the **first** request for a key:

- **RedisStore** — first hit does `INCR` + `PEXPIRE = windowMs`; Redis auto-deletes
  the key at expiry. Inspect with `redis-cli TTL rl:login:<key>`.
- **MemoryStore** — per-key `resetTime = firstHit + windowMs`; a cleanup timer
  frees expired entries.

The TTL is set **once** (when the counter goes 0→1) and is **not** refreshed by
later hits — so hammering a maxed-out key does not extend the lockout; it clears
on schedule (15 min, or 60s for media). `RateLimit-Reset` reports seconds
remaining.

---

## 7. Threat model — what this does and does not cover

**Covered (app layer):**
- Per-account brute-force / OTP guessing — tight per-identifier budgets.
- Enumeration oracles (voucher validate, media scrape) — per-user budgets.
- Multi-instance correctness — shared Redis counter.

**Deliberately NOT covered in-app — volumetric / spray abuse:**
An attacker on one IP spraying *many* identifiers gets a fresh bucket each time.
An in-app per-IP cap would fix that but **re-introduce the carrier-NAT lockout**
this design exists to prevent. So volumetric per-IP protection belongs at the
**edge**:

> **Cloudflare rate rules / AWS WAF rate-based rules** on the credential paths,
> using a **CAPTCHA challenge** rather than a hard block. A challenged carrier
> user solves a captcha; a spray bot fails it. Tracked as `// TODO WAF` in the
> CDK. If Cloudflare fronts the ALB, aggregate the WAF rule on the
> `CF-Connecting-IP` header, not the source IP (which is the CF edge).

---

## 8. Testing

- `rate-limit-client-ip.spec.ts` — `CF-Connecting-IP` preference + IP fallback.
- `rate-limit-store.spec.ts` — `FailOpenStore` fail-open behavior.
- `rate-limit-identifier.spec.ts` — identifier normalization, kind-isolation, IP
  fallback, phone canonicalization, same-IP/different-account isolation.

Validated end-to-end with a local 2-instance load-balancer harness
(`scratchpad/two-instance-test.sh`): 70 requests vs a limit of 30 → **60 allowed
in-memory** (the leak) vs **exactly 30 with Redis**; and a two-account/one-IP run
confirming user A exhausting their budget leaves user B unblocked.

---

## 9. Operations

**Verify live** (single instance can't distinguish store from the outside — both
enforce; use ≥2 instances or inspect Redis):
```bash
# fire N bogus logins; expect 429 after the limit for a given username
# with Redis, watch the shared counter:
redis-cli KEYS 'rl:*'
redis-cli TTL rl:login:<key>
```

**Tune** — limits/windows are per-limiter args in `rate-limit.middleware.ts`;
the identifier a limiter keys on is its `keyGenerator`. No route changes needed
(limiter export names are stable).

---

## 10. Non-goals / future work

- **Edge WAF** — the volumetric per-IP layer (§7). Highest-value follow-up.
- **Refresh-token reuse detection** — separate concern, tracked in
  `security-audit-followups.md`.
- Per-account lockout with progressive delay / captcha after repeated failures —
  a stronger complement to rate limiting, not yet implemented.
