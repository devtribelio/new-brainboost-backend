# AWS Deployment Runbook — bb-platform → Production (SELF-CONTAINED)

Panduan **lengkap & mandiri** dari nol sampai live di AWS. **Tidak perlu buka file lain.**
Arsitektur: **ECS Fargate + ALB(+WAF) + Amazon SQS + RDS PostgreSQL**. Region: **ap-southeast-3 (Jakarta)** — on-shore (latency + UU PDP).

## Daftar isi
1. Arsitektur & komponen (mana autoscale, mana singleton)
2. Estimasi biaya per tier (+ opsi RDS)
3. Daftar env var lengkap
4. Phase 0–10: langkah deploy berurutan
5. SQL reporting views + role read-only (inline)
6. Go-live checklist, rollback, teardown
7. **Re-deploy / update stack (CDK) — operasi RUTIN** ⭐
8. Terraform (otomasi)

> **Urutan PENTING** (DB dulu atau service dulu?):
> ```
> 0 Prasyarat → 1 VPC → 2 Secrets → 3 DATA (RDS,SQS,S3,ECR) ─┐ DB & queue harus ADA
> 4 Build image → 5 MIGRASI DB(+seed) → 6 ECS/ALB/WAF ───────┘ sebelum service nyala
> → 7 DNS+TLS → 8 Webhook+verify → 9 CI/CD → 10 Observability → GO-LIVE
> ```
> **RDS dibuat duluan → skema di-migrate → BARU service di-deploy.**

Ganti semua `<...>`. Variabel awal:
```bash
export AWS_REGION=ap-southeast-3
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PROJECT=bb
export ECR=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$PROJECT
```

---

## 1. Arsitektur & komponen

| Komponen | Sifat | Autoscale? | Platform |
|---|---|---|---|
| **mobile-api** | HTTP stateless (JWT) | ✅ **YA** (CPU~60% / req-count) | Fargate + ALB `/api/member/*` |
| **bb-comms** (Go, repo terpisah) | consumer SQS | ✅ **YA** (by queue depth) | Fargate (no ALB) |
| backoffice-api | HTTP internal | ⚪ fixed 1 | Fargate + ALB `/api/backoffice/*` |
| admin-ejs | HTTP internal | ⚪ fixed 1 | Fargate + ALB `/admin/*` |
| **comms-relay** | outbox→SQS (SendMessage) | 🔴 **SINGLETON (1, jangan scale)** | Fargate `desiredCount=1` |
| **cron** | job uang (PENDING→BALANCE, expire) | 🔴 **SINGLETON** | EventBridge Scheduled → RunTask |
| Comms broker | queue (managed) | ❌ | **Amazon SQS** (2 Standard queue: urgent, normal + DLQ) |
| PostgreSQL | DB (stateful) | ❌ | RDS Multi-AZ |
| Redis | shared rate-limit store (multi-task) | ❌ | ElastiCache `cache.t4g.micro` (dipasang di CDK; `REDIS_URL` di-inject ke task) |

**Image:** 3 dari repo ini (`mobile-api`, `backoffice-api`, `admin-ejs`) + 1 `bb-comms`. Image `mobile-api` dipakai **3 service** (command beda): `dist/main.js` (api), `dist/workers/comms-relay.js` (relay), `dist/jobs-runner.js` (cron). Jadi **4 image → 6 service**.

**Singleton wajib:** `comms-relay` (flip PENDING→SENT nggak concurrency-safe) & `cron` (double-run = uang diproses 2×). **Jangan masuk grup autoscale.**

**Integrasi eksternal (kredensial prod harus disiapin):** Xendit (payment+disbursement), RevenueCat (IAP), BunnyCDN (media), S3 (upload), Sumsub (KYC), FCM (push), SES (email), Qontak (WA OTP), Google+Apple (login).

**Topology:**
```
Internet → WAF → ALB(443) → /api/member/* → mobile-api (AUTOSCALE)
                            /api/backoffice/* → backoffice-api (1)
                            /admin/* → admin-ejs (1)
   ┌── VPC: public subnet (ALB) + private subnet (Fargate, RDS) ──────┐
   │  Fargate: mobile-api · backoffice · admin · bb-comms             │
   │           comms-relay(1) · cron(EventBridge)                     │
   │  Amazon SQS (managed, via VPC endpoint)   RDS Postgres (Multi-AZ)│
   │  VPC endpoints (S3/SQS/ECR/Logs/Secrets) → hindari NAT           │
   └──────────────────────────────────────────────────────────────────┘
```

---

## 2. Estimasi biaya (ap-southeast-3 Jakarta, on-demand, ±20%, tanpa Redis)

| Komponen | T1 ~10k MAU | T2 ~50k MAU | T3 ~200k MAU |
|---|---|---|---|
| Fargate (api+worker+comms) | ~$58 | ~$120 | ~$320 |
| ALB + WAF | ~$28 | ~$35 | ~$50 |
| Amazon SQS (2 queue) | ~$0–1 | ~$1–3 | ~$5–10 |
| NAT (atau VPC endpoints ~$10) | ~$33 | ~$35 | ~$40 |
| **RDS** (pilih di §opsi) | ~$60–90 | ~$120–187 | ~$290–450 |
| **TOTAL ≈** | **$180–220** | **$310–430** | **$720–1.200** |

**Opsi RDS (per tier):**
| Konfigurasi | T1 | T2 | T3 | Failover otomatis | Offload baca |
|---|---|---|---|---|---|
| Single-AZ, no replica | ~$32 | ~$67 | ~$159 | ❌ | ❌ |
| Single-AZ + 1 replica | ~$60 | ~$130 | ~$300 | ❌ (promote manual, bisa down + data loss) | ✅ |
| **Multi-AZ, no replica** (rekomendasi) | ~$60 | ~$120 | ~$290 | ✅ otomatis | ❌ |
| Multi-AZ + 1 replica | ~$90 | ~$187 | ~$450 | ✅ | ✅ |

Rekomendasi: **Multi-AZ no replica** (uptime buat user bayar), **tambah replica nanti** pas baca berat (no downtime). Hemat tanpa bayar-di-depan: **Fargate Spot** (~70% off burst) + **Savings Plan/RDS Reserved "No Upfront"** (~30–40% off baseline, ditagih bulanan). Read replica & Redis = **add-later** (zero/low downtime), nggak perlu dari awal.

---

## 3. Daftar env var (semua, dari `config/env.ts`)
Simpan SEMUA di Secrets Manager. `DATABASE_URL` & `SQS_COMMS_*_URL` diisi setelah RDS/SQS jadi (Phase 3).
```
NODE_ENV PORT BASE_URL APP_NAME LOG_LEVEL TRUST_PROXY API_DOCS_ENABLED
REDIS_URL   (rate-limit shared store; di-set otomatis oleh CDK dari ElastiCache. Kosong = MemoryStore per-proses)
DATABASE_URL
SQS_REGION SQS_COMMS_URGENT_URL SQS_COMMS_NORMAL_URL COMMS_RELAY_BATCH_SIZE COMMS_RELAY_INTERVAL_MS
(prod: SQS_ENDPOINT/SQS_ACCESS_KEY_ID/SQS_SECRET_ACCESS_KEY dikosongkan → pakai IAM task role)
JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_ACCESS_EXPIRES_IN JWT_REFRESH_EXPIRES_IN JWT_ANON_EXPIRES_IN
ADMIN_JWT_SECRET ADMIN_JWT_TTL ADMIN_COOKIE_NAME
OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET GOOGLE_CLIENT_IDS APPLE_CLIENT_IDS
XENDIT_SECRET_KEY XENDIT_CALLBACK_TOKEN
REVENUECAT_WEBHOOK_AUTH REVENUECAT_PROVIDER_NAME
BUNNY_STREAM_API_KEY BUNNY_STREAM_TOKEN_KEY BUNNY_STREAM_LIBRARY_ID BUNNY_STREAM_CDN_HOST BUNNY_REFERER
MEDIA_MODE MEDIA_TOKEN_SECRET MEDIA_TOKEN_TTL_SECONDS MEDIA_SIGNED_URL_TTL_SECONDS MEDIA_DOWNLOAD_TTL_SECONDS MEDIA_DEFAULT_RESOLUTION
SUMSUB_APP_TOKEN SUMSUB_SECRET_KEY SUMSUB_WEBHOOK_SECRET SUMSUB_BASE_URL SUMSUB_LEVEL_NAME SUMSUB_TOKEN_TTL_SECONDS
FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON
UPLOAD_MAX_BYTES UPLOAD_PUBLIC_BASE_URL UPLOAD_TEMP_DIR
COMMERCE_INVOICE_EXPIRY_HOURS COMMERCE_TRANSACTION_EXPIRY_HOURS
```
(Catatan: SES & Qontak dipakai oleh bb-comms — env-nya di repo bb-comms.)

---

## 4. Langkah deploy

### Phase 0 — Prasyarat (1×)
- [ ] AWS account + IAM admin (setup). Install **AWS CLI v2**, **Docker**, **jq**. `aws configure` region `ap-southeast-3`.
- [ ] Tentukan tier (§2) & punya domain. Set variabel di atas.

### Phase 1 — VPC / jaringan
- [ ] VPC, 2 AZ: 2 public subnet (ALB) + 2 private subnet (Fargate, RDS, MQ), Internet Gateway, route tables.
- [ ] **VPC Endpoints**: S3, ECR (api+dkr), CloudWatch Logs, Secrets Manager → hemat (hindari NAT). (NAT kecil hanya kalau butuh outbound internet penuh.)
- [ ] Security Groups:
  - `sg-alb`: in 80/443 dari internet.
  - `sg-app`: in dari `sg-alb` (3000/3001/3002); out all.
  - `sg-rds`: in 5432 **hanya dari `sg-app`**.
  - (SQS = managed, tanpa SG. Akses lewat **interface VPC endpoint** `com.amazonaws.ap-southeast-3.sqs`, SG endpoint in 443 dari `sg-app`.)

✅ VPC+subnet+SG+endpoint ada.

### Phase 2 — Secrets
```bash
aws secretsmanager create-secret --name $PROJECT/prod/app --secret-string '{
  "JWT_ACCESS_SECRET":"...","JWT_REFRESH_SECRET":"...","ADMIN_JWT_SECRET":"...",
  "XENDIT_SECRET_KEY":"...","XENDIT_CALLBACK_TOKEN":"...","REVENUECAT_WEBHOOK_AUTH":"...",
  "BUNNY_STREAM_API_KEY":"...","BUNNY_STREAM_TOKEN_KEY":"...","MEDIA_TOKEN_SECRET":"...",
  "SUMSUB_APP_TOKEN":"...","SUMSUB_SECRET_KEY":"...","SUMSUB_WEBHOOK_SECRET":"...",
  "FCM_SERVICE_ACCOUNT_JSON":"...","GOOGLE_CLIENT_IDS":"...","APPLE_CLIENT_IDS":"...",
  "OAUTH_CLIENT_ID":"...","OAUTH_CLIENT_SECRET":"..."
}'
```
`DATABASE_URL` & `SQS_COMMS_*_URL` ditambah setelah Phase 3.

### Phase 3 — DATA LAYER (duluan) + registry
**3a. RDS (Multi-AZ):**
```bash
aws rds create-db-instance --db-instance-identifier $PROJECT-prod \
  --engine postgres --engine-version 16 --db-instance-class db.t4g.small --multi-az \
  --allocated-storage 50 --storage-type gp3 \
  --master-username bb_admin --manage-master-user-password \
  --db-subnet-group-name $PROJECT-db-subnets --vpc-security-group-ids <sg-rds> \
  --backup-retention-period 7 --deletion-protection
```
Tunggu `available` → susun `DATABASE_URL` → masukin ke secret. (Replica NANTI: `create-db-instance-read-replica`.)

**3b. Amazon SQS (2 queue prioritas + DLQ):**
```bash
# 1) DLQ dulu
aws sqs create-queue --queue-name $PROJECT-comms-dlq
DLQ_URL=$(aws sqs get-queue-url --queue-name $PROJECT-comms-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ_URL --attribute-names QueueArn --query Attributes.QueueArn --output text)
# 2) urgent + normal, redrive ke DLQ (maxReceiveCount 5), visibility 60s
for q in comms-urgent comms-normal; do
  aws sqs create-queue --queue-name $PROJECT-$q \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\",\"VisibilityTimeout\":\"60\"}"
done
```
Simpan URL ke secret: `SQS_COMMS_URGENT_URL`, `SQS_COMMS_NORMAL_URL` (+ `SQS_REGION=ap-southeast-3`).
**IAM** (di Phase 6b task role): producer (mobile-api + comms-relay) butuh `sqs:SendMessage`; consumer **bb-comms** butuh `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` ke ARN kedua queue. Nama queue konstanta di `mq/topology.ts` — pastikan cocok.

**3c. S3 + ECR:**
```bash
aws s3 mb s3://$PROJECT-prod-uploads
for r in mobile-api backoffice-api admin-ejs bb-comms; do aws ecr create-repository --repository-name $PROJECT/$r; done
```
✅ RDS available, 2 SQS queue + DLQ ada, S3 + 4 ECR ada, secret lengkap.

### Phase 4 — Build & push image
```bash
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR
TAG=$(git rev-parse --short HEAD)
# dari root new-brainboost-backend:
docker build -f apps/mobile-api/Dockerfile     -t $ECR/mobile-api:$TAG .     && docker push $ECR/mobile-api:$TAG
docker build -f apps/backoffice-api/Dockerfile -t $ECR/backoffice-api:$TAG . && docker push $ECR/backoffice-api:$TAG
docker build -f apps/admin-ejs/Dockerfile      -t $ECR/admin-ejs:$TAG .      && docker push $ECR/admin-ejs:$TAG
# bb-comms (repo terpisah):
( cd ../bb-notification-service && docker build -t $ECR/bb-comms:$TAG . && docker push $ECR/bb-comms:$TAG )
```

### Phase 5 — MIGRASI DB (+seed) — setelah RDS, sebelum service
Image TIDAK menjalankan migrasi. Jalankan satu kali dari host/ECS-task yang punya `DATABASE_URL` prod (bastion / CloudShell di VPC / one-off ECS task pakai image mobile-api):
```bash
pnpm prisma:deploy     # apply semua migration (termasuk reporting views)
pnpm seed:admin        # admin awal
pnpm migrate:legacy    # impor data legacy (WRITE BERAT — window khusus, monitor CPU/IOPS)
```
Lalu jalankan **role read-only reporting** (§5) sebagai superuser.
✅ Tabel ada di RDS; `reporting.*` views ada; `analytics_ro` ada.

### Phase 6 — ECS Fargate + ALB + WAF + services
**6a.** Cluster: `aws ecs create-cluster --cluster-name $PROJECT-prod --capacity-providers FARGATE FARGATE_SPOT`
**6b.** IAM: `ecsTaskExecutionRole` (pull ECR + baca Secrets Manager + tulis Logs) & `taskRole` (S3 dll).
**6c.** Task definitions (6), inject env via `secrets` dari Secrets Manager, log ke CloudWatch:
| Service | Image | command | port | ALB |
|---|---|---|---|---|
| mobile-api | mobile-api | default `dist/main.js` | 3000 | `/api/member/*` |
| backoffice-api | backoffice-api | default | 3001 | `/api/backoffice/*` |
| admin-ejs | admin-ejs | default | 3002 | `/admin/*` |
| comms-relay | **mobile-api** | `node dist/workers/comms-relay.js` | – | – |
| cron | **mobile-api** | `node dist/jobs-runner.js` | – | EventBridge |
| bb-comms | bb-comms | (Go) | – | – |

**6d.** ALB (public subnet, `sg-alb`) + 3 target group (health `/health`) + listener rules (path-based) + **WAF** rate-based per-IP → associate ke ALB.
**6e.** Services:
- `mobile-api`: desired 2, autoscale target-tracking CPU~60% (min 2/max N), boleh FARGATE_SPOT.
- `backoffice-api`, `admin-ejs`: desired 1.
- `comms-relay`: **desired 1, NO autoscale**.
- `bb-comms`: desired 1, autoscale by SQS queue depth (`ApproximateNumberOfMessagesVisible`).
- `cron`: **bukan service** — **EventBridge Scheduler** RunTask cron `0 * * * *`, image mobile-api command `jobs-runner.js`.

✅ Semua task RUNNING & healthy; ALB target healthy.

### Phase 7 — DNS + TLS
- [ ] **ACM** cert untuk domain (validasi DNS/CNAME) → pasang ke ALB HTTPS(443); redirect 80→443.
- [ ] **Route 53** A/ALIAS domain → ALB.

✅ `curl https://<domain>/health` → 200.

### Phase 8 — Repoint webhook + verifikasi
- [ ] Xendit → `https://<domain>/api/webhook/xendit/invoice` (+ `/xendit/disbursement`), token sama.
- [ ] RevenueCat → `.../api/webhook/revenuecat` (secret di DB).
- [ ] Sumsub → `.../api/webhook/sumsub`.
- [ ] Apple/Google redirect/bundle prod; BunnyCDN/S3/FCM/SES/Qontak kredensial prod.
- [ ] Smoke: register/login, checkout sandbox→PAID→**enrollment muncul**, push, email/WA OTP.

### Phase 9 — CI/CD (GitHub Actions)
On push `develop`/`main`: (1) build+push image (tag=SHA), (2) **migrasi** one-off ECS task `prisma:deploy` **kalau `prisma/migrations` berubah**, (3) `aws ecs update-service --force-new-deployment` (rolling, ALB drain). Pakai **OIDC role** (tanpa long-lived key). Staging dulu → smoke → promote prod.

### Phase 10 — Observability
- [ ] CloudWatch Logs per service. RDS **Performance Insights** ON.
- [ ] Alarm: RDS CPU>70%/storage/connections; ECS CPU & task count; ALB 5xx & unhealthy; SQS queue depth & age-of-oldest-message (consumer macet) & DLQ>0. Budget alarm.

---

## 5. SQL reporting + role read-only (inline)

**Reporting views** (di-apply otomatis lewat `prisma:deploy`, schema `reporting`):
`daily_revenue`, `product_revenue`, `checkout_funnel`, `abandoned_checkouts`,
`paid_without_enrollment` (leak detector), `payment_health`, `affiliate_performance`,
`commission_ledger`, `acquisition_by_source`, `member_first_purchase`.

**Role read-only buat tim analytics/back-office** (jalankan sebagai superuser; `bb_user` nggak punya CREATEROLE). SELECT-only, schema `reporting` aja (no PII, no tabel mentah):
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='analytics_ro') THEN
    CREATE ROLE analytics_ro LOGIN PASSWORD '<STRONG_PASSWORD>';
  END IF;
END $$;
GRANT CONNECT ON DATABASE bb_backend TO analytics_ro;
GRANT USAGE  ON SCHEMA reporting     TO analytics_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO analytics_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO analytics_ro;
REVOKE ALL ON SCHEMA public FROM analytics_ro;   -- nggak boleh sentuh tabel mentah/PII
ALTER ROLE analytics_ro SET statement_timeout = '30s';
```
> Catatan superuser di RDS: master user RDS bisa `CREATE ROLE` (rds_superuser). Jalankan ini connect sebagai master user.

---

## 6. Go-live checklist · rollback · teardown

**Go-live:**
- [ ] RDS Multi-AZ, backup ON, deletion protection ON.
- [ ] Semua secret di Secrets Manager (bukan plaintext di task def).
- [ ] WAF aktif; HTTPS only; `API_DOCS_ENABLED=false` di prod publik.
- [ ] **comms-relay desired 1; cron via EventBridge** — double-run = uang dobel.
- [ ] Migrasi+seed sukses; `reporting.*` + `analytics_ro` ada.
- [ ] Webhook (Xendit/RC/Sumsub) nunjuk prod & terverifikasi.
- [ ] Health hijau; smoke test lulus; alarm+log aktif.

**Rollback:** `aws ecs update-service` balik ke task-def revision sebelumnya (rolling). Hindari migration destruktif; punya restore PITR RDS. DNS tetap (ALB stabil) — rollback = ganti task def, bukan DNS.

**Teardown (kebalikan):** services → ALB/WAF → EventBridge → ECS cluster → SQS queue + DLQ → **RDS (paling akhir, matiin deletion protection dulu)** → VPC.

---

## 7. Re-deploy / update stack (CDK) — operasi RUTIN ⭐

Ini buat **update stack yang UDAH live** (ganti image / ubah env / fix bug) — **bukan dari nol**.
Infra (RDS, SQS, S3, ECR, ALB, cluster, secret) udah ada → cukup **build image baru + `cdk deploy`**.

### Model mental (WAJIB paham)
```
  KODE  →  docker build  →  IMAGE di ECR (per repo, dikasih TAG)
  CDK   →  cdk deploy    →  ECS pakai IMAGE:TAG + inject ENV dari Secrets Manager
```
- **Image** = hasil build kode app. Tiap repo punya image sendiri (`mobile-api` dari backend, `bb-comms` dari `../bb-notification-service`).
- **CDK** (`infra/cdk/lib/bb-ecs-stack.ts`) = cetak biru. `cdk deploy` baca file ini → suruh ECS pakai tag + set env.
- **Perubahan ENV/config** (mis. `TRUST_PROXY`) ada di **CDK**, BUKAN di image → cukup `cdk deploy`, **nggak perlu rebuild image**.

### ⚠️ Gotcha #1 — satu `imageTag` untuk SEMUA image
Stack referensi tiap image pakai `props.imageTag` yang **sama** (`fromEcrRepository(repo, props.imageTag)`).
→ `mobile-api` & `bb-comms` **harus eksis di tag yang sama**. Kalau bump tag buat satu image, **rebuild + push SEMUA image di tag itu**.
→ **Jangan** overwrite tag lama (CloudFormation nggak deteksi perubahan digest → service nggak ke-redeploy).

### ⚠️ Gotcha #2 — PULL DULU dari KEDUA repo (sering ke-gigit)
Backend & bb-comms repo **terpisah**, PR/branch sering gerak. **`git fetch` + build dari `main` terbaru** sebelum build. Berkali-kali kejadian: image ke-build dari `main` lokal yang basi (mis. masih versi RabbitMQ, atau kelewat fix yang udah di-merge).
```bash
cd new-brainboost-backend     && git fetch origin && git checkout main && git pull --ff-only
cd ../bb-notification-service && git fetch origin && git checkout main && git pull --ff-only
```

### Langkah
```bash
# 0) variabel + login ECR (token expired ~12 jam, login tiap sesi)
export AWS_REGION=ap-southeast-3
REG=276713243639.dkr.ecr.ap-southeast-3.amazonaws.com
export ECR=$REG/bb
export TAG=$(cd new-brainboost-backend && git rev-parse --short HEAD)   # label rilis = sha backend
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REG

# 1) mobile-api (dari backend/main) — ARM64 (Fargate Graviton)
cd new-brainboost-backend
docker build --platform linux/arm64 -f apps/mobile-api/Dockerfile -t $ECR/mobile-api:$TAG . && docker push $ECR/mobile-api:$TAG

# 2) bb-comms (dari bb-notification-service/main) — di-tag SAMA ($TAG)
cd ../bb-notification-service
docker build --platform linux/arm64 -t $ECR/bb-comms:$TAG . && docker push $ECR/bb-comms:$TAG

# 3) diff dulu (selalu, biar nggak kaget)
cd ../new-brainboost-backend/infra/cdk && npm install
npx cdk diff   -c rdsSecurityGroupId=sg-0e08f50ffbee9fa8d -c imageTag=$TAG -c certificateArn=$CERT_ARN

# 4) deploy (ECS rolling update, ALB drain, zero-downtime)
npx cdk deploy -c rdsSecurityGroupId=sg-0e08f50ffbee9fa8d -c imageTag=$TAG -c certificateArn=$CERT_ARN
```

### Parameter tetap (saat ini)
| | |
|---|---|
| Account / Region | `276713243639` / `ap-southeast-3` |
| ECR | `276713243639.dkr.ecr.ap-southeast-3.amazonaws.com/bb` |
| RDS SG (`-c rdsSecurityGroupId`) | `sg-0e08f50ffbee9fa8d` |
| Fargate SG | `sg-039f5d4c5b0e9d979` |
| Cert ARN (`-c certificateArn=$CERT_ARN`) | `arn:aws:acm:ap-southeast-3:276713243639:certificate/b2e2ef7f-bfb2-453c-a686-fd0cc21f97c3` |
| Domain | `bb-be.brainboost.id` (Cloudflare DNS-only → ALB) |
| Secret | `bb/prod/app` (key names di CDK `secrets`, values cuma di Secrets Manager) |

### Hanya ubah ENV (tanpa rebuild image)
Mis. fix `TRUST_PROXY`: edit `lib/bb-ecs-stack.ts` → `cdk deploy` pakai **tag lama** (image nggak berubah):
```bash
npx cdk deploy -c rdsSecurityGroupId=sg-0e08f50ffbee9fa8d -c imageTag=<tag-lama> -c certificateArn=$CERT_ARN
```

### Verifikasi
```bash
curl -s https://bb-be.brainboost.id/api/member/product/list/public | head -c 200   # API hidup
aws logs tail /bb/prod/mobile-api --since 5m --region ap-southeast-3 | grep -i "ERR_ERL\|error" || echo "bersih"
```

### Setelah deploy
- **Commit perubahan CDK → PR ke main** (jangan commit langsung ke `main` lokal terus push sembarangan).
- Rollback = `cdk deploy` balik ke `imageTag` revisi sebelumnya (DNS/ALB tetap, cuma ganti task def).

---

## 8. Otomasi Terraform (disarankan setelah paham alur)
Manual CLI bagus buat paham urutan; produksi sebaiknya Terraform biar reproducible & staging≈prod.
Modul: `vpc`, `rds`, `mq`, `ecr`, `ecs`, `alb`, `wafv2`, `acm`, `route53`, `secretsmanager`, `cloudwatch`.
Struktur: `infra/terraform/{network,data,compute,edge}` + workspace `staging`/`prod`.
```
network → data (rds, mq, s3, ecr, secrets) → compute (ecs, taskdef, service, autoscale, eventbridge) → edge (alb, waf, acm, route53)
```
DB engine (RDS standar vs Aurora Serverless v2) = keputusan terpisah; default runbook ini = **RDS Multi-AZ no replica**, replica/Redis add-later.
