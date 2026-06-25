# Release Readiness Checklist — new-brainboost-backend

Status: actionable checklist (pendamping `aws-deployment-runbook.md`)
Tanggal: 2026-06-23 · Branch audit: `develop`
Verdict: **BELUM ready** — kode/migration/Dockerfile siap, tapi infra (DB, broker, Fargate) belum diprovisioning.

---

## 0. Message broker: Amazon SQS (sudah migrasi dari RabbitMQ) ✅
- Per commit **`4b7e447` / PR #82** (`feat(comms): migrate producer transport from RabbitMQ to Amazon SQS`), transport comms sudah pindah ke **Amazon SQS**. `publisher.ts` pakai `SQSClient`+`SendMessageCommand`, dep `@aws-sdk/client-sqs`. RabbitMQ/amqplib **sudah tidak dipakai**.
- **2 queue Standard** (1 per prioritas, gantikan routing key direct-exchange): `urgent` (OTP, payment, disbursement) & `normal` (reminder, digest). NAMA queue = konstanta di `mq/topology.ts`; URL queue = env (`SQS_COMMS_URGENT_URL`, `SQS_COMMS_NORMAL_URL`).
- Local dev: **ElasticMQ** (`SQS_ENDPOINT` + dummy creds). Prod: `endpoint`/creds kosong → SDK pakai **IAM role task** Fargate.
- SQS hanya untuk jalur **comms/notifikasi** (OTP, receipt, push). API inti (katalog, pembelian) tidak butuh queue untuk melayani request — tapi **email/phone OTP login lewat jalur ini**, jadi queue + `bb-comms` tetap wajib untuk login penuh.
- ⚠️ Pastikan konsumer **`bb-comms`** (repo `bb-notification-service`) juga sudah migrasi ke konsumsi SQS (bukan AMQP) — verifikasi repo terpisah.

## 1. Yang SUDAH siap (tidak perlu dikerjakan)
- [x] Kode 3 service (mobile-api, backoffice-api, admin-ejs) + 2 worker (comms-relay, cron)
- [x] Config env lengkap & tervalidasi — `packages/common/src/config/env.ts`
- [x] Dockerfile multi-stage (3) + healthcheck `/health` + `tini`
- [x] 49 Prisma migration + seed scripts (`seed:admin`, `seed:settings`, `seed:revenuecat-iap`)
- [x] Runbook 10 fase — `docs/infra/aws-deployment-runbook.md`
- [x] `ecosystem.config.js` (PM2) + `docker-compose.mobile.yml` (dev)

## 2. Infra yang HARUS diprovisioning (urut)

### Fase 1 — Jaringan
- [ ] VPC 2 AZ (subnet publik + privat)
- [ ] Security groups: `alb`, `app`, `rds`, `mq`

### Fase 2 — Secrets
- [ ] AWS Secrets Manager diisi SEMUA env dari `env.ts` (DATABASE_URL, JWT secrets, **SQS_REGION + SQS_COMMS_URGENT_URL + SQS_COMMS_NORMAL_URL**, XENDIT_*, REVENUECAT_*, BUNNY_*, SUMSUB_*, FCM_*, S3_*, MEDIA_*). Prod: SQS_ENDPOINT/keys kosong → pakai IAM role.

### Fase 3 — Data store & queue
- [ ] **RDS PostgreSQL** Multi-AZ (mulai `db.t4g.small`, storage 50GB, backup 7 hari, deletion-protection ON)
- [ ] **2 SQS Standard queue**: `comms-urgent` & `comms-normal` (+ DLQ disarankan). Isi URL-nya ke env. (Yang sudah dibuat tinggal dipastikan 2 prioritas + region `ap-southeast-3`.)
- [ ] **IAM policy** untuk task role Fargate: `sqs:SendMessage` (producer mobile-api/relay) & `sqs:ReceiveMessage`/`DeleteMessage` (consumer bb-comms)
- [ ] **S3 bucket** upload (`bb-prod-uploads`)
- [ ] **ECR** repos (4): mobile-api, backoffice-api, admin-ejs, bb-comms

### Fase 4 — Build
- [ ] Build 3 image → push ke ECR
- [ ] Build & push `bb-comms` (repo terpisah `bb-notification-service`)

### Fase 5 — Migrasi DB (SEBELUM service boot)
- [ ] Jalankan `pnpm prisma:deploy` via one-off ECS task / CloudShell (Dockerfile sengaja TIDAK auto-migrate)
- [ ] Seed: `pnpm seed:admin`, `pnpm seed:settings`, `pnpm seed:revenuecat-iap`
- [ ] (Opsional) `pnpm migrate:legacy` kalau perlu impor data lama — write-heavy, pantau

### Fase 6 — ECS/Fargate + ALB + WAF
- [ ] ECS cluster (Fargate + Fargate Spot)
- [ ] 5 task definition (ref secret dari Secrets Manager):
  - [ ] `mobile-api` — desired 2, autoscale 2→N (CPU ~60%)
  - [ ] `backoffice-api` — desired 1
  - [ ] `admin-ejs` — desired 1
  - [ ] `comms-relay` — desired **1, JANGAN autoscale** (PENDING→SENT flip belum concurrency-safe)
  - [ ] `bb-comms` — desired 1 (atau autoscale by queue depth)
- [ ] `bb-cron` — **bukan service**: EventBridge Scheduler → Fargate RunTask **hourly** (single-shot; double-run = double duit diproses)
- [ ] ALB (subnet publik) + target group healthcheck `/health` (3 API)
- [ ] WAF rate-limit per-IP → attach ke ALB

### Fase 7 — DNS/TLS
- [ ] ACM cert domain
- [ ] Route 53 A-record → ALB
- [ ] `curl https://<domain>/health` → 200

### Fase 8 — Webhook re-point ke domain prod
- [ ] Xendit (callback)
- [ ] RevenueCat — **PASTIKAN ngarah ke backend baru ini**, bukan `revenuecat-webhook` (Deno→Tribeversity lama). Lihat risiko R1 di subscription plan.
- [ ] Sumsub (KYC)

### Fase 9 — CI/CD (boleh menyusul, tidak blocking go-live manual)
- [ ] GitHub Actions: build→push ECR→one-off migration task→rolling update ECS

### Fase 10 — Observability
- [ ] CloudWatch Logs per service
- [ ] RDS Performance Insights
- [ ] Alarm: RDS CPU>70%, ECS CPU, ALB 5xx, MQ queue depth, budget

## 3. Gate go-live (smoke test e2e)
- [ ] register → login (OTP terkirim lewat SQS→bb-comms) → katalog tampil
- [ ] checkout → bayar (Xendit sandbox) → webhook → `CourseEnrollment` ter-grant → konten kebuka
- [ ] comms-relay: outbox PENDING→SENT (SendMessage ke SQS), bb-comms consume & kirim
- [ ] cron sekali jalan: `affiliatePendingToBalance` + `expirePendingPayments` tidak dobel

## 4. Estimasi & catatan
- Effort provisioning (ikut runbook, manual CLI): **~2–3 minggu**. Murni kerjaan ops/infra — bisa didelegasi.
- IaC (Terraform/CDK) belum ada; runbook manual CLI cukup untuk rilis pertama, IaC bisa menyusul.
- `comms-relay` & `cron` = **singleton**. Jangan pernah di-autoscale (PENDING→SENT flip belum concurrency-safe).
- SQS yang sudah dibuat = **benar dan dipakai** (transport comms sejak PR #82). Pastikan ada 2 queue (urgent+normal) + IAM role.
