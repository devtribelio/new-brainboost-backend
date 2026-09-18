#!/usr/bin/env bash
# Siapkan SATU aset audio sebagai file tunggal untuk `media_audio_sources`.
#
#   ./scripts/media-encode-audio.sh <guid> <input-audio-or-video> [--env staging|prod] [--reencode 96k]
#
# Yang dilakukan:
#   1. ffmpeg: buang track video, ambil audio sebagai ADTS .aac
#      - default: salin track audio apa adanya (tanpa encode ulang, tanpa penurunan kualitas)
#        HANYA kalau sumbernya sudah AAC; kalau bukan (mp3/wav/opus) → encode ke AAC 128k
#      - --reencode 96k : paksa encode ulang ke bitrate itu (file lebih kecil)
#   2. ffprobe: durasi (detik) ; sha256 ; ukuran byte
#   3. unggah ke s3://<bucket>/private/audio/<guid>/<version>.aac  (prefix private/ = presigned/CDN-signed saja, konvensi S3StorageService)
#   4. cetak SQL INSERT (is_active=false) + UPDATE untuk mengaktifkan — TIDAK dijalankan otomatis
#
# Tidak menyentuh Bunny, tidak menyentuh database. Aman diulang: versi naik kalau key sudah ada.
set -euo pipefail

GUID="${1:-}"; INPUT="${2:-}"; shift 2 || true
ENV_NAME=staging; REENCODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --reencode) REENCODE="$2"; shift 2 ;;
    *) echo "argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$GUID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "guid harus UUID Bunny (36 char), dapat: '$GUID'"
[[ -f "$INPUT" ]] || die "file input tidak ada: $INPUT"
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || die "butuh ffmpeg + ffprobe (brew install ffmpeg)"
command -v aws >/dev/null || die "butuh aws cli"

case "$ENV_NAME" in
  staging) BUCKET=brainboost-staging;    REGION=ap-southeast-1 ;;
  prod)    BUCKET=brainboost-production; REGION=ap-southeast-3 ;;
  *) die "--env harus staging|prod" ;;
esac

# ---- versi: naik kalau key sudah ada (jangan pernah menimpa file yang mungkin sedang diunduh) ----
VERSION=1
while aws s3api head-object --bucket "$BUCKET" --key "private/audio/$GUID/$VERSION.aac" --region "$REGION" >/dev/null 2>&1; do
  VERSION=$((VERSION+1))
done
KEY="private/audio/$GUID/$VERSION.aac"
OUT="$(mktemp -d)/$GUID-$VERSION.aac"

# ---- 1. encode ----
SRC_CODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$INPUT" | head -1)
[[ -n "$SRC_CODEC" ]] || die "tidak ada track audio di $INPUT"
say "Sumber: codec audio=$SRC_CODEC  ->  $KEY"

if [[ -n "$REENCODE" ]]; then
  say "Encode ulang ke AAC $REENCODE (mono kalau sumber mono, sample rate dipertahankan)"
  ffmpeg -v error -y -i "$INPUT" -vn -c:a aac -b:a "$REENCODE" -f adts "$OUT"
  CODEC_LABEL="aac-$REENCODE"
elif [[ "$SRC_CODEC" == "aac" ]]; then
  say "Salin track AAC apa adanya (tanpa encode ulang)"
  ffmpeg -v error -y -i "$INPUT" -vn -c:a copy -f adts "$OUT"
  CODEC_LABEL="aac"
else
  say "Sumber bukan AAC -> encode ke AAC 128k"
  ffmpeg -v error -y -i "$INPUT" -vn -c:a aac -b:a 128k -f adts "$OUT"
  CODEC_LABEL="aac-128k"
fi

# ---- 2. metadata ----
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
DUR_SEC=$(printf '%.0f' "$DUR")
BYTES=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
# sanity: playlist satu segmen butuh durasi > 0 dan file yang benar-benar berisi audio
[[ "$DUR_SEC" -gt 0 ]] || die "durasi 0 — hasil encode tidak valid"
[[ "$BYTES" -gt 100000 ]] || die "file terlalu kecil ($BYTES byte) — cek input"
say "Hasil: durasi=${DUR_SEC}s  ukuran=$((BYTES/1024/1024)) MB  sha256=${SHA:0:12}…  ($(( BYTES*8/DUR_SEC/1000 )) kbps rata-rata)"

# ---- 3. unggah (privat: tidak ada ACL publik; policy bucket tidak mencakup private/) ----
say "Unggah ke s3://$BUCKET/$KEY"
aws s3 cp "$OUT" "s3://$BUCKET/$KEY" --region "$REGION" --content-type audio/aac --cache-control "public, max-age=31536000, immutable" >/dev/null
echo "  unggah ok"
printf "  tanpa signed  -> %s (harus 403)\n" "$(curl -s -o /dev/null -w '%{http_code}' "https://$BUCKET.s3.$REGION.amazonaws.com/$KEY")"
printf "  dengan signed -> %s (harus 200)\n" "$(curl -s -o /dev/null -w '%{http_code}' "$(aws s3 presign "s3://$BUCKET/$KEY" --region "$REGION" --expires-in 120)")"

# ---- 4. SQL ----
say "Jalankan di database $ENV_NAME (baris NONAKTIF dulu):"
cat <<SQL
INSERT INTO media_audio_sources (guid, audio_key, version, codec, duration_sec, bytes, sha256, is_active, encoded_at, lesson_id)
VALUES ('$GUID', '$KEY', $VERSION, '$CODEC_LABEL', $DUR_SEC, $BYTES, '$SHA', false, now(),
  -- lesson yang memakai guid ini (dari slides_data); NULL = tidak ada lesson yang memakainya → cek guid-nya
  (SELECT l.id FROM course_lessons l
    WHERE jsonb_typeof(l.slides_data) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.slides_data) e
                  WHERE e->'data'->>'guid' = '$GUID' OR e->'data'->'audio'->>'guid' = '$GUID' OR e->'data'->'video'->>'guid' = '$GUID')
    ORDER BY l.created_at LIMIT 1))
ON CONFLICT (guid) DO UPDATE SET
  audio_key = EXCLUDED.audio_key, version = EXCLUDED.version, codec = EXCLUDED.codec,
  duration_sec = EXCLUDED.duration_sec, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
  encoded_at = EXCLUDED.encoded_at, lesson_id = EXCLUDED.lesson_id;

-- pastikan barisnya menempel ke lesson yang benar (lesson_id NULL = guid salah):
SELECT product_title, lesson_name, stored_matches FROM media_audio_source_lessons WHERE guid = '$GUID';

-- saat siap diuji:
UPDATE media_audio_sources SET is_active = true  WHERE guid = '$GUID';
-- rollback kapan pun:
UPDATE media_audio_sources SET is_active = false WHERE guid = '$GUID';
SQL
say "Selesai. File lokal: $OUT"
