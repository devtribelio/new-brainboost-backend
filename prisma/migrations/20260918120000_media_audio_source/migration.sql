-- Audio lessons as ONE file on our own S3/CDN, opt-in per asset.
--
-- Offline downloads on Android fail on Xiaomi/POCO because one HLS lesson is
-- 780-920 tiny WorkManager jobs that the OS stops (`canceled`). The app that is
-- already in the stores downloads "every segment listed in the playlist", so the
-- fix lives here: for a guid with an ACTIVE row, /media/hls hands out a playlist
-- containing a single .aac segment served from `audio_key`. No row = Bunny HLS,
-- byte-for-byte as before. Rollback per asset = is_active=false, no deploy.
CREATE TABLE "media_audio_sources" (
  "guid"         TEXT         NOT NULL,
  "audio_key"    TEXT         NOT NULL,
  "version"      INTEGER      NOT NULL DEFAULT 1,
  "codec"        TEXT         NOT NULL DEFAULT 'aac',
  "duration_sec" INTEGER      NOT NULL,
  "bytes"        INTEGER      NOT NULL,
  "sha256"       TEXT         NOT NULL,
  "is_active"    BOOLEAN      NOT NULL DEFAULT true,
  "encoded_at"   TIMESTAMP(3) NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_audio_sources_pkey" PRIMARY KEY ("guid")
);
