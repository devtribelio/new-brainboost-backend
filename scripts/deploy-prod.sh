#!/usr/bin/env bash
# Deploy bb-platform ke ECS Fargate prod (ap-southeast-3).
#
#   ./scripts/deploy-prod.sh            # build + push + diff + deploy (tag = git sha HEAD)
#   ./scripts/deploy-prod.sh --diff     # berhenti setelah diff, TIDAK deploy
#
# Kenapa script ini ada: stack butuh 5 context flag, dan TIDAK satupun tersimpan
# di cdk.json. Lupa salah satu = prod rusak. Yang paling berbahaya:
#   certificateArn kosong  -> listener HTTPS 443 DIHAPUS (semua traffic mobile mati)
#   resyncEnabled bukan true -> resync worker dihapus
# Script ini mengunci kelimanya + menurunkan tag image yang benar secara otomatis.
set -euo pipefail

# ---- konstanta infra (stabil; ubah hanya kalau infra-nya memang pindah) ----
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

# helper: tag image yang SEDANG live untuk sebuah service (mis. ResyncSvc)
live_tag_of() {
  local match="$1"
  local svc td
  svc=$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" \
        --query "serviceArns[?contains(@,'${match}')]" --output text 2>/dev/null | head -1)
  [[ -z "$svc" || "$svc" == "None" ]] && return 1
  td=$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --region "$AWS_REGION" \
       --query 'services[0].taskDefinition' --output text 2>/dev/null)
  aws ecs describe-task-definition --task-definition "$td" --region "$AWS_REGION" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null | sed 's|.*:||'
}

ecr_has_tag() {
  aws ecr describe-images --repository-name "$1" --region "$AWS_REGION" \
    --image-ids "imageTag=$2" >/dev/null 2>&1
}

# ---- 0. guard ----
say "Cek working tree"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  warn "Working tree ADA perubahan belum di-commit."
  warn "Image akan di-tag pakai sha HEAD, tapi isinya = kode lokal Anda -> tag berbohong."
  read -rp "Lanjut? (ketik 'yes'): " a; [[ "$a" == "yes" ]] || die "Dibatalkan."
fi

TAG=$(git rev-parse --short HEAD)
say "Deploy tag: $TAG  ($(git log --oneline -1 --format=%s | cut -c1-60))"

# ---- 1. build + push mobile-api ----
say "Login ECR"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_HOST" >/dev/null
echo "ok"

say "Build mobile-api:$TAG  (ARM64 native — stack pakai Graviton)"
# context = repo ROOT: Dockerfile butuh packages/, prisma/, lockfile
docker build -f apps/mobile-api/Dockerfile -t "$ECR_HOST/bb/mobile-api:$TAG" .

say "Push mobile-api:$TAG"
docker push "$ECR_HOST/bb/mobile-api:$TAG"

# ---- 2. bb-comms: repo TERPISAH, tapi stack pakai imageTag yang sama ----
# Konvensi repo ini: image bb-comms di-tag pakai sha MONOREPO tiap deploy.
# Kalau tag belum ada, artinya bb-comms belum di-build untuk sha ini.
say "Cek bb-comms:$TAG"
if ecr_has_tag bb/bb-comms "$TAG"; then
  echo "sudah ada."
else
  LIVE_COMMS=$(live_tag_of BbCommsSvc) || die "Tidak bisa baca tag bb-comms yang live."
  warn "bb/bb-comms:$TAG TIDAK ADA di ECR. Yang live sekarang: $LIVE_COMMS"
  warn "bb-comms itu repo Go TERPISAH. Kalau kodenya TIDAK berubah, retag aman"
  warn "(digest sama, cuma dikasih nama baru). Kalau bb-comms BARU di-update,"
  warn "JANGAN retag — build & push dari repo bb-comms dulu, lalu jalankan ulang."
  read -rp "Retag $LIVE_COMMS -> $TAG? (ketik 'retag' / Enter untuk batal): " a
  [[ "$a" == "retag" ]] || die "Dibatalkan. Build bb-comms dulu."
  MANIFEST=$(aws ecr batch-get-image --repository-name bb/bb-comms --region "$AWS_REGION" \
             --image-ids "imageTag=$LIVE_COMMS" --query 'images[0].imageManifest' --output text)
  aws ecr put-image --repository-name bb/bb-comms --region "$AWS_REGION" \
    --image-tag "$TAG" --image-manifest "$MANIFEST" >/dev/null
  echo "retag ok."
fi

# ---- 3. resync-worker: throwaway, punya siklus rilis sendiri ----
# resyncImageTag default = imageTag; kalau tag itu tidak ada, task gagal pull.
# Jadi pin ke apa pun yang SEDANG live.
say "Cek resync-worker"
if RESYNC_TAG=$(live_tag_of ResyncSvc) && [[ -n "$RESYNC_TAG" ]]; then
  echo "live: $RESYNC_TAG -> di-pin (resync tidak ikut naik; itu alat transisi sekali pakai)"
else
  RESYNC_TAG="$TAG"
  warn "Resync service tidak ketemu. Pakai $TAG — pastikan image-nya ada."
fi

# ---- 4. diff ----
CTX=(
  -c "imageTag=$TAG"
  -c "rdsSecurityGroupId=$RDS_SG"
  -c "resyncEnabled=true"
  -c "resyncImageTag=$RESYNC_TAG"
  -c "certificateArn=$CERT_ARN"
)

cd infra/cdk
[[ -d node_modules ]] || { say "npm install"; npm install; }

export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" AWS_REGION

say "cdk diff"
npx cdk diff "${CTX[@]}" 2>&1 | tee /tmp/bb-cdk-diff.txt

# Pagar terakhir: baris 'destroy' di diff = ada resource prod mau dihapus.
if grep -qE '^\[-\].*destroy' /tmp/bb-cdk-diff.txt; then
  warn "DIFF MENGANDUNG 'destroy' — ada resource prod yang akan DIHAPUS:"
  grep -E '^\[-\]' /tmp/bb-cdk-diff.txt || true
  warn "Kalau ada Listener/TargetGroup di situ, kemungkinan besar ada context flag hilang."
  read -rp "Yakin lanjut? (ketik 'destroy-ok'): " a; [[ "$a" == "destroy-ok" ]] || die "Dibatalkan."
fi

if $DIFF_ONLY; then
  say "--diff: berhenti di sini. Tidak ada yang di-deploy."
  exit 0
fi

# ---- 5. deploy ----
say "cdk deploy  (CDK akan minta konfirmasi kalau ada perubahan security group)"
npx cdk deploy "${CTX[@]}"

# ---- 6. verifikasi: CFN bilang sukses != service sehat ----
say "Verifikasi service"
for s in $(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" \
           --query 'serviceArns' --output text | tr '\t' '\n' | sed 's|.*/||'); do
  read -r td run des dep <<< "$(aws ecs describe-services --cluster "$CLUSTER" --services "$s" \
      --region "$AWS_REGION" \
      --query 'services[0].[taskDefinition,runningCount,desiredCount,length(deployments)]' \
      --output text 2>/dev/null)"
  img=$(aws ecs describe-task-definition --task-definition "$td" --region "$AWS_REGION" \
        --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null | sed 's|.*/||')
  printf "  %-18s %-26s run=%s/%s deployments=%s\n" \
    "$(echo "$s" | sed 's/BbEcsStack-//;s/Service.*//')" "$img" "$run" "$des" "$dep"
done
echo
echo "  deployments=1 di semua service = rolling update sudah stabil."
echo "  ResyncSvc sengaja TIDAK ikut naik (di-pin ke $RESYNC_TAG)."

say "Cek listener ALB (443 HARUS ada)"
ALB=$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
      --query "LoadBalancers[?contains(LoadBalancerName,'BbEcs')].LoadBalancerArn" --output text | head -1)
aws elbv2 describe-listeners --load-balancer-arn "$ALB" --region "$AWS_REGION" \
  --query 'Listeners[].[Port,Protocol]' --output text

say "Selesai. Jangan lupa (kalau ada setting baru): pnpm seed:settings"
