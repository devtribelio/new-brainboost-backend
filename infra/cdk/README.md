# bb-infra-cdk — ECS Fargate deployment (Jakarta)

CDK (TypeScript) buat deploy backend ke **ECS Fargate** di `ap-southeast-3`.
Stack: `BbEcsStack` — mobile-api (autoscale + ALB), comms-relay (singleton),
cron (EventBridge hourly), bb-comms (SQS consumer).
NOTE: backoffice-api (skeleton kosong) & admin-ejs (panel admin, belum perlu) DI-SKIP.
Image-nya tetap di ECR; tambah service-nya nanti kalau dibutuhin.

## Arsitektur yang dibikin
```
Internet → ALB(80) → (default) → mobile-api (autoscale 2→6, CPU 60%)
ECS Fargate (default VPC, public subnet, SG appSg):
  mobile-api · comms-relay(1, singleton) · bb-comms
  cron → EventBridge Scheduler (0 * * * *) → RunTask jobs-runner.js
appSg → diizinkan masuk ke bb-sg-rds:5432
```

## Prasyarat (sebelum deploy)
1. **ECR repo** (4) + image udah di-push dengan tag yang sama:
   ```bash
   for r in mobile-api backoffice-api admin-ejs bb-comms; do aws ecr create-repository --repository-name bb/$r --region ap-southeast-3; done
   # build & push (tag = git sha), lihat runbook Phase 4
   ```
2. **Secrets Manager** secret `bb/prod/app` (JSON) berisi semua env dari `packages/common/src/config/env.ts`:
   - `DATABASE_URL` → **pakai user `bb_app`** (bukan migrator/master), endpoint RDS, `?sslmode=require`
   - `SQS_COMMS_URGENT_URL`, `SQS_COMMS_NORMAL_URL`
   - JWT secrets, XENDIT_*, REVENUECAT_*, BUNNY_*, SUMSUB_*, FCM_*, MEDIA_*, OAUTH_*
   - (tambah key-nya juga di `lib/bb-ecs-stack.ts` → object `secrets`)
3. **DB udah dimigrasi** (`prisma:deploy` sbg bb_migrator) — Fargate cuma runtime.
4. **bb-comms** `feat/sqs-transport` udah di-merge & image-nya ke-build.
5. Isi **`rdsSecurityGroupId`** (id `bb-sg-rds`) di `cdk.json` atau lewat `-c`.

## Deploy
```bash
cd infra/cdk
npm install
export CDK_DEFAULT_ACCOUNT=276713243639
export AWS_REGION=ap-southeast-3

# pertama kali di account/region ini:
npx cdk bootstrap aws://276713243639/ap-southeast-3

# lihat dulu apa yang dibuat:
npx cdk diff -c rdsSecurityGroupId=sg-xxxx -c imageTag=$(git rev-parse --short HEAD)

# deploy:
npx cdk deploy -c rdsSecurityGroupId=sg-xxxx -c imageTag=$(git rev-parse --short HEAD)
```
Output `AlbDns` = endpoint ALB → tes `curl http://<AlbDns>/health`.

## Yang masih TODO (sengaja di-stub, lihat komentar di stack)
- **HTTPS**: tambah listener 443 + ACM cert (set `certificateArn`), redirect 80→443.
- **WAF**: associate WAFv2 web ACL (rate-based per-IP) ke ALB.
- **Persempit IAM SQS**: ganti `resources:['*']` → ARN 2 queue.
- **Secrets lengkap**: tambah sisa vendor creds ke object `secrets`.
- **VPC privat**: sekarang pakai public subnet default VPC + assignPublicIp (paling simpel).
  Buat lebih aman → subnet privat + NAT/VPC endpoints (butuh ubah VPC).

## Update versi (deploy ulang)
Build+push image tag baru → `npx cdk deploy -c imageTag=<sha>`. ECS rolling update otomatis (ALB drain).

## Teardown
`npx cdk destroy` (RDS/SQS/Lightsail TIDAK termasuk — itu dibuat manual, di luar stack ini).
