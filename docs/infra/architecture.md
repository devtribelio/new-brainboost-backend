# Infrastructure Architecture — bb-platform (2026-06-17)

Target cloud architecture for the bb-platform backend + bb-comms, post-migration
from the legacy tribelio-platform. Region: **ap-southeast-3 (Jakarta)** — on-shore
for Indonesian users (latency + UU PDP data residency); all required services available.

Decisions locked: **ECS Fargate** (autoscale, pay-as-you-go, no upfront), **no Redis**
(deferred — see §6), **RDS PostgreSQL Multi-AZ + 1 read replica**, **Amazon SQS** as the
comms broker (migrated from RabbitMQ — PR #82). Region locked to **ap-southeast-3**.

---

## 1. Component inventory & scale policy

| Component | Type | Scale policy | Platform |
|---|---|---|---|
| **bb-mobile-api** | stateless HTTP (JWT) | ✅ **autoscale** 1→N (target CPU ~60% / ALB req-count) | Fargate service behind ALB |
| **bb-comms** (Go) | SQS consumer | ✅ **autoscale** by queue depth (competing consumers) | Fargate service (no ALB) |
| bb-backoffice-api | stateless HTTP, internal | ⚪ fixed 1 (opt. 2 for HA) | Fargate service behind ALB (path `/api/backoffice/*`) |
| bb-admin-ejs | stateless HTTP, internal | ⚪ fixed 1 | Fargate service (internal/ALB `/admin/*`) |
| **bb-comms-relay** | outbox → SQS (SendMessage) | 🔴 **SINGLETON — never scale** (PENDING→SENT flip not concurrency-safe) | Fargate service `desiredCount=1` |
| **bb-cron** | hourly money jobs (PENDING→BALANCE, expire-payments) | 🔴 **SINGLETON** (double-run = double money) | EventBridge Scheduled → Fargate task (or `desiredCount=1`) |
| Comms broker | queue (managed) | ❌ no autoscale | **Amazon SQS** — 2 Standard queues (`urgent`, `normal`) + DLQ |
| **PostgreSQL** | DB (stateful) | ❌ no autoscale | **RDS Multi-AZ + 1 read replica** |
| External SaaS | Xendit, RevenueCat, BunnyCDN, S3, Sumsub, FCM, SES, Qontak, Google/Apple | n/a | vendor-managed |

**Only 2 services autoscale** (mobile-api by traffic, bb-comms by queue). 2 are
**hard singletons** (cron, relay). Everything else fixed or managed.

## 2. Topology

```
Internet
  │
  ├─ CloudFront/Bunny (media, static) ─ offloads heavy media
  │
  ▼
 WAF (rate-based per-IP)  →  ALB (HTTPS, /health checks)
                              │  /api/member/*     → mobile-api      (AUTOSCALE 1→N)
                              │  /api/backoffice/* → backoffice-api   (fixed 1)
                              │  /admin/*          → admin-ejs        (fixed 1)
                              ▼
        ┌──────────── VPC (private subnets, multi-AZ) ────────────┐
        │  Fargate services (stateless, no sticky — JWT)          │
        │     mobile-api · backoffice-api · admin-ejs · bb-comms  │
        │     bb-comms-relay (1) · bb-cron (1, EventBridge)       │
        │                                                          │
        │  (Amazon SQS = managed,       RDS Postgres:               │
        │   reached via VPC endpoint)   • primary (Multi-AZ)       │
        │                               • read replica ×1 ─────────┼──► reporting / analytics_ro
        │  [Redis slot — RESERVED, not deployed]                  │
        └──────────────────────────────────────────────────────────┘
        VPC endpoints (S3, SQS, SES, ECR, logs) → avoid NAT cost where possible
```

## 3. Network (VPC) — designed so Redis/replica drop in later with zero rework
- **One VPC**, 2+ AZs, public subnets (ALB only) + private subnets (Fargate, RDS). SQS is a managed service (not in-VPC) — reach via interface VPC endpoint.
- **VPC endpoints** for S3 / SQS / ECR / CloudWatch / SES → cuts NAT Gateway data cost.
- ElastiCache (Redis) and extra RDS replicas can be added into the same private
  subnets later with just a provision + security-group change (no topology change).

## 4. Autoscale policy
- **mobile-api**: target-tracking on CPU ~60% (or ALB `RequestCountPerTarget`), min 1–2 / max N. Scale-to-min off-peak. Fargate **Spot** for burst tasks.
- **bb-comms**: scale on SQS queue depth (`ApproximateNumberOfMessagesVisible` CloudWatch metric) — more consumers drain backlog faster.
- **Singletons (cron, relay)**: `desiredCount=1`, no scaling policy. Cron preferably EventBridge-scheduled (near-zero idle cost).
- **Prereqs**: graceful SIGTERM (drain in-flight requests/messages), `/health` for ALB.

## 5. Security state across instances (why no Redis is OK)
- OTP/credential brute-force is capped **per-account in the DB** (`otp_codes.attempts`, max 5) — IP-independent, scales fine.
- Per-IP throttling moved to **AWS WAF** (rate-based rule at the edge) instead of in-app in-memory limiters.
- JWT = stateless → no server session store needed.

## 6. Redis — deferred, not removed
Not needed at launch. Add **only when** caching is required to relieve DB load. It is
an **additive side-car** (no migration, no downtime): provision ElastiCache in the
existing VPC + add cache-aside in the (already centralized) domain service layer,
incrementally per hot query. **Capacity trigger:** RDS CPU sustained >70%, rising
read latency, or slow-query growth in Performance Insights → then: (1) optimize
indexes, (2) lean on the read replica, (3) add Redis cache for hottest reads.

## 7. Cost (ap-southeast-3 Jakarta, on-demand, approx ±20%, no Redis)

RDS = **Multi-AZ primary + 1 read replica + storage**.

| | Tier 1 (~10k MAU) | Tier 2 (~50k MAU) | Tier 3 (~200k MAU) |
|---|---|---|---|
| Fargate (api+workers+comms) | ~$58 | ~$120 | ~$320 |
| ALB + WAF | ~$28 | ~$35 | ~$50 |
| Amazon SQS (2 queues) | ~$0–1 | ~$1–3 | ~$5–10 |
| NAT (or VPC endpoints) | ~$33 / ~$10 | ~$35 | ~$40 |
| **RDS** (Multi-AZ + 1 replica + storage) | db.t4g.small ~$90 | db.t4g.medium ~$187 | db.m6g.large ~$450 |
| **TOTAL ≈** | **$220–250** | **$420–480** | **$900–1,300** |

**RDS dominates at scale.** Cost levers (no upfront): Fargate Spot (~70% off burst),
Compute Savings Plan + RDS Reserved "No Upfront" (~30–40% off steady baseline,
billed monthly), single-AZ if HA not required, VPC endpoints to avoid NAT.

## 8. Open items
- **Pin tier**: needs legacy MAU / peak-concurrency estimate.
- **DB engine**: standard RDS Postgres vs Aurora Serverless v2 (auto-scaling DB, better for spiky load — revisit in the DB-specific pass).
- Migration window: initial legacy import is write-heavy → provision burst headroom + storage to legacy data size.
