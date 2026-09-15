#!/usr/bin/env bash
# Deploy HANYA resync-worker ke ECS Fargate prod (ap-southeast-3).
#
#   ./scripts/deploy-resync.sh          # build + push resync-worker + diff + deploy
#   ./scripts/deploy-resync.sh --diff   # berhenti setelah diff, TIDAK deploy
#
# Kenapa terpisah dari deploy-prod.sh:
#   deploy-prod.sh sengaja MEM-PIN resync ke tag live (resync = alat transisi, tidak
#   ikut naik). Jadi update kode resync TIDAK akan pernah ke-deploy lewat sana.
#   Script ini kebalikannya: cuma resync-worker yang naik; mobile-api + bb-comms
#   DI-PIN ke image yang SEDANG live (tag-nya dibaca otomatis dari service) supaya
#   keduanya tidak ikut rolling-update. Semua context flag stack tetap dikunci
#   (certificateArn dll) supaya cdk tidak menghapus listener 443 / resource prod.
set -euo pipefail

# ---- konstanta infra (samakan dengan deploy-prod.sh) ----
AWS_REGION=ap-southeast-3
ACCOUNT_ID=276713243639
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
CLUSTER=bb-prod
RDS_SG=sg-0e08f50ffbee9fa8d
CERT_ARN="arn:aws:acm:${AWS_REGION}:${ACCOUNT_ID}:certificate/b2e2ef7f-bfb2-453c-a686-fd0cc21f97c3"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DIFF_ONLY=false
[[ "${1:-}" == "--diff" ]] && DIFF_ONLY=true

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# Baca tag image yang SEDANG live untuk service yang container image-nya = ECR repo $1.
# Lebih robust dari cocokkan nama service: langsung cocokkan path repo di image URI.
live_tag_of_repo() {
  local repo="$1" svc td img
  for svc in $(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" \
               --query 'serviceArns' --output text 2>/dev/null | tr '\t' '\n'); do
    td=$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --region "$AWS_REGION" \
         --query 'services[0].taskDefinition' --output text 2>/dev/null)
    img=$(aws ecs describe-task-definition --task-definition "$td" --region "$AWS_REGION" \
          --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null)
    if [[ "$img" == *"/${repo}:"* ]]; then echo "${img##*:}"; return 0; fi
  done
  return 1
}

# ---- 0. guard: working tree bersih (image di-tag pakai sha HEAD) ----
say "Cek working tree"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  warn "Working tree ADA perubahan belum di-commit."
  warn "Image resync di-tag pakai sha HEAD, tapi isinya = kode lokal Anda -> tag berbohong."
  read -rp "Lanjut? (ketik 'yes'): " a; [[ "$a" == "yes" ]] || die "Dibatalkan."
fi

TAG=$(git rev-parse --short HEAD)
say "Resync deploy tag: $TAG  ($(git log --oneline -1 --format=%s | cut -c1-60))"

# ---- 1. pin mobile-api + bb-comms ke tag LIVE (jangan ikut naik) ----
say "Baca tag live mobile-api + bb-comms (untuk di-pin)"
MOBILE_TAG=$(live_tag_of_repo bb/mobile-api) \
  || die "Tidak bisa baca tag mobile-api yang live — batal (tanpa ini, imageTag default 'latest' bisa memaksa mobile-api redeploy)."
COMMS_TAG=$(live_tag_of_repo bb-comms) \
  || die "Tidak bisa baca tag bb-comms yang live — batal."
echo "  mobile-api live: $MOBILE_TAG  (di-pin)"
echo "  bb-comms   live: $COMMS_TAG  (di-pin)"
[[ "$MOBILE_TAG" == "$TAG" ]] && warn "Tag mobile-api live == $TAG (kebetulan sama sha). Aman: image-nya tidak berubah."

# ---- 2. build + push resync-worker (ARM64 — stack pakai Graviton) ----
say "Login ECR"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_HOST" >/dev/null
echo "ok"

say "Build resync-worker:$TAG  (ARM64; context = repo ROOT, butuh packages/ + prisma/ + lockfile)"
docker build --platform linux/arm64 \
  -f apps/resync-worker/Dockerfile -t "$ECR_HOST/bb/resync-worker:$TAG" .

say "Push resync-worker:$TAG"
docker push "$ECR_HOST/bb/resync-worker:$TAG"

# ---- 3. context: cuma resyncImageTag yang berubah; sisanya dikunci ke live ----
CTX=(
  -c "imageTag=$MOBILE_TAG"        # PIN mobile-api (tidak redeploy)
  -c "commsImageTag=$COMMS_TAG"    # PIN bb-comms  (tidak redeploy)
  -c "rdsSecurityGroupId=$RDS_SG"
  -c "resyncEnabled=true"
  -c "resyncImageTag=$TAG"         # <- SATU-SATUNYA yang naik
  -c "certificateArn=$CERT_ARN"
)

cd infra/cdk
[[ -d node_modules ]] || { say "npm install"; npm install; }
export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" AWS_REGION

say "cdk diff  (HARUS cuma menyentuh ResyncTask/ResyncSvc; mobile-api & bb-comms TIDAK berubah)"
npx cdk diff "${CTX[@]}" 2>&1 | tee /tmp/bb-resync-diff.txt

# Pagar 1: jangan ada resource prod yang dihapus.
if grep -qE '^\[-\].*destroy' /tmp/bb-resync-diff.txt; then
  warn "DIFF MENGANDUNG 'destroy' — ada resource prod yang akan DIHAPUS:"
  grep -E '^\[-\]' /tmp/bb-resync-diff.txt || true
  warn "Kemungkinan besar ada context flag hilang. JANGAN lanjut sebelum yakin."
  read -rp "Yakin lanjut? (ketik 'destroy-ok'): " a; [[ "$a" == "destroy-ok" ]] || die "Dibatalkan."
fi

# Pagar 2: mobile-api / bb-comms tidak boleh ikut berubah di deploy resync-only.
if grep -qiE 'MobileApi|bb-comms|BbComms' /tmp/bb-resync-diff.txt; then
  warn "DIFF menyentuh mobile-api / bb-comms — seharusnya keduanya di-PIN & tidak berubah."
  grep -iE 'MobileApi|bb-comms|BbComms' /tmp/bb-resync-diff.txt | head || true
  read -rp "Tetap lanjut? (ketik 'ya'): " a; [[ "$a" == "ya" ]] || die "Dibatalkan — cek tag pin."
fi

if $DIFF_ONLY; then
  say "--diff: berhenti di sini. Tidak ada yang di-deploy."
  exit 0
fi

# ---- 4. deploy ----
say "cdk deploy  (hanya ResyncSvc yang rolling-update)"
npx cdk deploy "${CTX[@]}"

# ---- 5. verifikasi ----
say "Verifikasi ResyncSvc"
for s in $(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" \
           --query 'serviceArns' --output text | tr '\t' '\n' | sed 's|.*/||'); do
  [[ "$s" == *Resync* ]] || continue
  read -r td run des dep <<< "$(aws ecs describe-services --cluster "$CLUSTER" --services "$s" \
      --region "$AWS_REGION" \
      --query 'services[0].[taskDefinition,runningCount,desiredCount,length(deployments)]' \
      --output text 2>/dev/null)"
  img=$(aws ecs describe-task-definition --task-definition "$td" --region "$AWS_REGION" \
        --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null | sed 's|.*/||')
  printf "  %-18s %-28s run=%s/%s deployments=%s\n" \
    "$(echo "$s" | sed 's/BbEcsStack-//;s/Service.*//')" "$img" "$run" "$des" "$dep"
done
echo
echo "  Target: image = bb/resync-worker:$TAG, deployments=1 (rolling stabil)."
echo "  Cek log worker: aws logs tail /ecs/... (atau CloudWatch) untuk baris fix-password-algo."
say "Selesai. Kalau butuh backfill sekali jalan: 'pnpm resync fix-password-algo' via one-shot task."
