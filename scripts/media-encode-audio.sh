#!/usr/bin/env bash
# Siapkan SATU aset audio untuk `media_audio_sources`: encode, potong jadi
# beberapa bagian, unggah ke S3 (privat), cetak SQL.
#
#   ./scripts/media-encode-audio.sh <guid> <input-audio-or-video> [--env staging|prod] [--parts 120] [--reencode 96k]
#
# Kenapa DIPOTONG (default 8 bagian), bukan satu file:
#   pengunduh di aplikasi versi toko mengambil segmen per batch (12 di 3.3.3, 8 di 3.4.0)
#   dan loop Dart yang menjadwalkan batch BERIKUTNYA dibekukan MIUI saat aplikasi di
#   latar belakang. Bagian ≤ batch app = satu batch, tidak ada batch kedua yang bisa macet,
#   (keputusan 2026-09-18: 12 bagian = batch 3.3.3; 3.4.0 wajib batch ≥ 16, jangan 8)
#   retry per bagian (~7 MB, bukan seluruh pelajaran), dan bar progres bergerak
#   (aplikasi menghitung progres = bagian selesai / total bagian).
#   Satu file (--parts 1) tetap didukung: bar diam di 0% lalu lompat ke 100%.
#
# Yang dilakukan:
#   1. ffmpeg: buang track video, ambil audio (salin kalau sudah AAC, kalau tidak encode 128k; --reencode memaksa)
#   2. ffmpeg hls muxer: potong jadi N bagian .ts dengan durasi akurat per bagian
#   3. unggah ke s3://<bucket>/private/audio/<guid>/<version>/NNN.ts (privat; presigned/CDN-signed saja)
#   4. cetak SQL INSERT (is_active=false, lesson_id otomatis dari slides_data) — TIDAK dijalankan otomatis
#
# Tidak menyentuh Bunny, tidak menyentuh database. Aman diulang: versi naik kalau prefix sudah ada.
set -euo pipefail

GUID="${1:-}"; INPUT="${2:-}"; shift 2 || true
ENV_NAME=staging; REENCODE=""; PARTS=120
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --reencode) REENCODE="$2"; shift 2 ;;
    --parts) PARTS="$2"; shift 2 ;;
    *) echo "argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$GUID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "guid harus UUID Bunny (36 char), dapat: '$GUID'"
[[ -f "$INPUT" ]] || die "file input tidak ada: $INPUT"
[[ "$PARTS" =~ ^[0-9]+$ && "$PARTS" -ge 1 && "$PARTS" -le 200 ]] || die "--parts harus 1..200 (default 120; lihat migrasi 20260922120000)"
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || die "butuh ffmpeg + ffprobe (brew install ffmpeg)"
command -v aws >/dev/null && command -v python3 >/dev/null || die "butuh aws cli + python3"

case "$ENV_NAME" in
  staging) BUCKET=brainboost-staging;    REGION=ap-southeast-1 ;;
  prod)    BUCKET=brainboost-production; REGION=ap-southeast-3 ;;
  *) die "--env harus staging|prod" ;;
esac

# ---- versi: naik kalau prefix sudah terisi (jangan pernah menimpa file yang mungkin sedang diunduh) ----
VERSION=1
while [[ -n "$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "private/audio/$GUID/$VERSION/" --max-keys 1 --region "$REGION" --query 'Contents[0].Key' --output text 2>/dev/null | grep -v '^None$')" ]] \
   || aws s3api head-object --bucket "$BUCKET" --key "private/audio/$GUID/$VERSION.aac" --region "$REGION" >/dev/null 2>&1; do
  VERSION=$((VERSION+1))
done
PREFIX="private/audio/$GUID/$VERSION"
WORK="$(mktemp -d)"
FULL="$WORK/full.aac"

# ---- 1. audio utuh ----
SRC_CODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$INPUT" | head -1)
[[ -n "$SRC_CODEC" ]] || die "tidak ada track audio di $INPUT"
say "Sumber: codec audio=$SRC_CODEC  ->  s3://$BUCKET/$PREFIX/  ($PARTS bagian)"
if [[ -n "$REENCODE" ]]; then
  say "Encode ulang ke AAC $REENCODE"; ffmpeg -v error -y -i "$INPUT" -vn -c:a aac -b:a "$REENCODE" -f adts "$FULL"; CODEC_LABEL="aac-$REENCODE"
elif [[ "$SRC_CODEC" == "aac" ]]; then
  say "Salin track AAC apa adanya"; ffmpeg -v error -y -i "$INPUT" -vn -c:a copy -f adts "$FULL"; CODEC_LABEL="aac"
else
  say "Sumber bukan AAC -> encode ke AAC 128k"; ffmpeg -v error -y -i "$INPUT" -vn -c:a aac -b:a 128k -f adts "$FULL"; CODEC_LABEL="aac-128k"
fi
# Durasi untuk MERENCANAKAN potongan diambil dari kontainer sumber (mp4/mp3/wav punya
# durasi asli). ADTS tidak punya field durasi -> ffprobe menebak dari bitrate (~5% lebih
# panjang). Durasi yang DISIMPAN dijumlah dari hasil potongan (lihat setelah langkah 2).
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT" 2>/dev/null | grep -E '^[0-9.]+$' || true)
[[ -n "$DUR" ]] || DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FULL")
DUR_SEC=$(printf '%.0f' "$DUR")
BYTES=$(stat -f%z "$FULL" 2>/dev/null || stat -c%s "$FULL"); SHA=$(shasum -a 256 "$FULL" | awk '{print $1}')
[[ "$DUR_SEC" -gt 0 ]] || die "durasi 0 — hasil encode tidak valid"
[[ "$BYTES" -gt 100000 ]] || die "file terlalu kecil ($BYTES byte) — cek input"
say "Audio utuh: ${DUR_SEC}s ($((DUR_SEC/60)) menit), $((BYTES/1024/1024)) MB, $(( BYTES*8/DUR_SEC/1000 )) kbps"

# ---- 2. potong ----
SEG_TIME=$(( (DUR_SEC + PARTS - 1) / PARTS ))
mkdir -p "$WORK/parts"
say "Potong jadi ≈$PARTS bagian (~${SEG_TIME}s per bagian, MPEG-TS, tanpa encode ulang)"
ffmpeg -v error -y -i "$FULL" -c:a copy -f hls -hls_time "$SEG_TIME" -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_filename "$WORK/parts/%03d.ts" "$WORK/parts/index.m3u8"
python3 - "$WORK/parts/index.m3u8" "$WORK/parts" > "$WORK/segments.json" <<'PY'
import sys, json, os
m3u8, d = sys.argv[1], sys.argv[2]
segs = []; dur = None
for line in open(m3u8):
    line = line.strip()
    if line.startswith('#EXTINF:'): dur = float(line[8:].split(',')[0])
    elif line and not line.startswith('#'):
        segs.append({"file": line, "durationSec": round(dur, 3), "bytes": os.path.getsize(os.path.join(d, line))})
print(json.dumps(segs))
PY
N=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$WORK/segments.json")
DUR_SEC=$(python3 -c "import json,sys;print(round(sum(s['durationSec'] for s in json.load(open(sys.argv[1])))))" "$WORK/segments.json")
echo "  bagian: $N"
python3 -c "
import json,sys
for s in json.load(open(sys.argv[1])): print(f\"   {s['file']}  {s['durationSec']:8.3f}s  {s['bytes']/1024/1024:5.1f} MB\")" "$WORK/segments.json"

# ---- 3. unggah ----
say "Unggah $N bagian ke s3://$BUCKET/$PREFIX/"
for f in "$WORK"/parts/*.ts; do
  aws s3 cp "$f" "s3://$BUCKET/$PREFIX/$(basename "$f")" --region "$REGION" --content-type video/mp2t --cache-control "public, max-age=31536000, immutable" >/dev/null
done
echo "  unggah ok"
FIRST="$PREFIX/000.ts"
printf "  tanpa signed  -> %s (harus 403)\n" "$(curl -s -o /dev/null -w '%{http_code}' "https://$BUCKET.s3.$REGION.amazonaws.com/$FIRST")"
printf "  dengan signed -> %s (harus 200)\n" "$(curl -s -o /dev/null -w '%{http_code}' "$(aws s3 presign "s3://$BUCKET/$FIRST" --region "$REGION" --expires-in 120)")"

# ---- 4. SQL ----
SEGMENTS_JSON=$(python3 -c "
import json,sys
p=sys.argv[2]; out=[{'key': f\"{p}/{s['file']}\", 'durationSec': s['durationSec'], 'bytes': s['bytes']} for s in json.load(open(sys.argv[1]))]
print(json.dumps(out, separators=(',',':')))" "$WORK/segments.json" "$PREFIX")
say "Jalankan di database $ENV_NAME (baris NONAKTIF dulu):"
cat <<SQL
INSERT INTO media_audio_sources (guid, audio_key, version, codec, duration_sec, bytes, sha256, segments, is_active, encoded_at, lesson_id)
VALUES ('$GUID', '$PREFIX/', $VERSION, '$CODEC_LABEL', $DUR_SEC, $BYTES, '$SHA', '$SEGMENTS_JSON'::jsonb, false, now(),
  -- lesson yang memakai guid ini (dari slides_data); NULL = tidak ada lesson yang memakainya → cek guid-nya
  (SELECT l.id FROM course_lessons l
    WHERE jsonb_typeof(l.slides_data) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.slides_data) e
                  WHERE e->'data'->>'guid' = '$GUID' OR e->'data'->'audio'->>'guid' = '$GUID' OR e->'data'->'video'->>'guid' = '$GUID')
    ORDER BY l.created_at LIMIT 1))
ON CONFLICT (guid) DO UPDATE SET
  audio_key = EXCLUDED.audio_key, version = EXCLUDED.version, codec = EXCLUDED.codec,
  duration_sec = EXCLUDED.duration_sec, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
  segments = EXCLUDED.segments, encoded_at = EXCLUDED.encoded_at, lesson_id = EXCLUDED.lesson_id;

-- pastikan menempel ke lesson yang benar (lesson_id NULL = guid salah):
SELECT product_title, lesson_name, stored_matches FROM media_audio_source_lessons WHERE guid = '$GUID';
-- saat siap diuji:
UPDATE media_audio_sources SET is_active = true  WHERE guid = '$GUID';
-- rollback kapan pun:
UPDATE media_audio_sources SET is_active = false WHERE guid = '$GUID';
SQL
say "Selesai. Kerja lokal: $WORK"
