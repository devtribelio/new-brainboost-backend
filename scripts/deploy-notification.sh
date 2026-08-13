#!/usr/bin/env bash
# Deploy bb-notification-service (Go) → ECS service `bb-comms` di bb-prod.
#
#   ./scripts/deploy-notification.sh            # build + push + diff + deploy
#   ./scripts/deploy-notification.sh --diff     # berhenti setelah diff
#
# Kenapa terpisah dari deploy-prod.sh: bb-comms di-build dari repo LAIN
# (bb-notification-service) dan sekarang punya tag sendiri (commsImageTag,
# lihat feat/decouple-comms-image). Jadi rilis notification TIDAK perlu
# rebuild mobile-api — mobile-api dibiarkan di tag yang sedang live.
set -euo pipefail

AWS_REGION=ap-southeast-3
ACCOUNT=276713243639
ECR="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
CLUSTER=bb-prod
RDS_SG=sg-0e08f50ffbee9fa8d
CERT="arn:aws:acm:${AWS_REGION}:${ACCOUNT}:certificate/b2e2ef7f-bfb2-453c-a686-fd0cc21f97c3"
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Repo notification = sibling dari backend repo. Override dgn: NOTIF_REPO=/path ./deploy-notification.sh
NOTIF_REPO="${NOTIF_REPO:-$BACKEND/../bb-notification-service}"
RESYNC_TAG=a532c61   # image resync-worker yg sudah di-build (interval 600 + kode merge)

DIFF_ONLY=false
[[ "${1:-}" == "--diff" ]] && DIFF_ONLY=true

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

live_tag_of(){ # $1 = substring service
  local svc td
  svc=$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" \
        --query "serviceArns[?contains(@,'$1')]" --output text 2>/dev/null | sed 's|.*/||' | head -1)
  [[ -z "$svc" || "$svc" == "None" ]] && return 1
  td=$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --region "$AWS_REGION" \
       --query 'services[0].taskDefinition' --output text 2>/dev/null)
  aws ecs describe-task-definition --task-definition "$td" --region "$AWS_REGION" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null | sed 's|.*:||'
}

# ---- tag notification = HEAD repo bb-notification-service ----
[[ -d "$NOTIF_REPO/.git" ]] || die "Repo notification tidak ada di $NOTIF_REPO"
if [[ -n "$(git -C "$NOTIF_REPO" status --porcelain --untracked-files=no)" ]]; then
  warn "Repo notification ADA perubahan belum di-commit — image di-tag pakai sha HEAD tapi isinya kode lokal."
  read -rp "Lanjut? (ketik yes): " a; [[ "$a" == yes ]] || die "Dibatalkan."
fi
COMMS_TAG=$(git -C "$NOTIF_REPO" rev-parse --short HEAD)

# ---- mobile-api: JANGAN diubah — pakai tag yang sedang live ----
IMAGE_TAG=$(live_tag_of mobileapi) || die "Tidak bisa baca tag mobile-api live."

say "Rencana deploy"
echo "  mobile-api  : $IMAGE_TAG   (TIDAK diubah — tidak di-rebuild)"
echo "  bb-comms    : $COMMS_TAG   (notification, di-build sekarang)"
echo "  resync      : $RESYNC_TAG  (interval 600 + kode merge — ikut karena ada di main)"

# ---- build + push bb-comms (arm64/Graviton) ----
say "Login ECR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR" >/dev/null
echo ok

say "Build bb-comms:$COMMS_TAG dari $NOTIF_REPO (linux/arm64)"
docker build --platform linux/arm64 -f "$NOTIF_REPO/Dockerfile" -t "$ECR/bb/bb-comms:$COMMS_TAG" "$NOTIF_REPO"

say "Push bb-comms:$COMMS_TAG"
docker push "$ECR/bb/bb-comms:$COMMS_TAG"

# ---- prasyarat image lain harus SUDAH ada di ECR ----
say "Cek image prasyarat sudah ada di ECR"
for pair in "mobile-api:$IMAGE_TAG" "resync-worker:$RESYNC_TAG"; do
  repo="bb/${pair%%:*}"; tag="${pair##*:}"
  aws ecr describe-images --repository-name "$repo" --region "$AWS_REGION" --image-ids "imageTag=$tag" >/dev/null 2>&1 \
    && echo "  ✅ $repo:$tag" || die "$repo:$tag TIDAK ADA di ECR — deploy akan gagal."
done

# ---- diff ----
CTX=(
  -c "imageTag=$IMAGE_TAG"
  -c "commsImageTag=$COMMS_TAG"
  -c "resyncImageTag=$RESYNC_TAG"
  -c "resyncEnabled=true"
  -c "rdsSecurityGroupId=$RDS_SG"
  -c "certificateArn=$CERT"
)
cd "$BACKEND/infra/cdk"
[[ -d node_modules ]] || { say "npm install"; npm install; }
export CDK_DEFAULT_ACCOUNT="$ACCOUNT" AWS_REGION

say "cdk diff"
npx cdk diff "${CTX[@]}" 2>&1 | tee /tmp/notif-diff.txt

if grep -qE '^\[-\].*destroy' /tmp/notif-diff.txt; then
  warn "DIFF MENGANDUNG 'destroy' — ada resource prod yang akan DIHAPUS:"
  grep -E '^\[-\]' /tmp/notif-diff.txt || true
  warn "Kalau ada SSM /bb/shared-alb/* di situ = shared-ALB kehapus. STOP dan cek."
  read -rp "Yakin lanjut? (ketik destroy-ok): " a; [[ "$a" == destroy-ok ]] || die "Dibatalkan."
fi

if $DIFF_ONLY; then say "--diff: berhenti. Tidak deploy."; exit 0; fi

# ---- deploy ----
say "cdk deploy (jawab y kalau ada konfirmasi)"
npx cdk deploy "${CTX[@]}"

# ---- verifikasi ----
say "Verifikasi service"
for s in mobileapi BbComms Resync CommsRelay; do
  t=$(live_tag_of "$s" 2>/dev/null) || continue
  printf "  %-12s -> %s\n" "$s" "$t"
done
echo "  Harapan: mobileapi=$IMAGE_TAG (tetap), BbComms=$COMMS_TAG (baru), Resync=$RESYNC_TAG"
say "Selesai."
