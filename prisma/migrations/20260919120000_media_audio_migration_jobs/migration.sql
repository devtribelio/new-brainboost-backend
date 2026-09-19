-- Work queue for "move this audio asset to our own storage", written by the
-- backoffice (plain SQL: one INSERT per button press) and drained by the
-- `migrateAudioToStorage` job on the 5-minute cron lane. Same split as payout
-- approval: the backoffice only records intent; ffmpeg, the Bunny token key and
-- the S3 credentials stay in the backend.
--
-- Separate from media_audio_sources on purpose: that table is what the app is
-- SERVED from, and a half-finished migration must never be readable there.
--
-- id has a DB default because the writer is not Prisma (uuid(7) is client-side).
CREATE TABLE "media_audio_migration_jobs" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "guid"         TEXT NOT NULL,
  "lesson_id"    UUID,
  "status"       TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED | PROCESSING | DONE | FAILED
  "parts"        INTEGER NOT NULL DEFAULT 12,
  "attempts"     INTEGER NOT NULL DEFAULT 0,
  "error"        TEXT,
  "requested_by" TEXT,                               -- bo_users id/email; backoffice-owned, no FK
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"   TIMESTAMP(3),
  "finished_at"  TIMESTAMP(3),
  CONSTRAINT "media_audio_migration_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_audio_migration_jobs_parts_check" CHECK ("parts" BETWEEN 1 AND 12),
  CONSTRAINT "media_audio_migration_jobs_status_check"
    CHECK ("status" IN ('REQUESTED', 'PROCESSING', 'DONE', 'FAILED'))
);

CREATE INDEX "media_audio_migration_jobs_status_requested_at_idx"
  ON "media_audio_migration_jobs"("status", "requested_at");
CREATE INDEX "media_audio_migration_jobs_guid_idx" ON "media_audio_migration_jobs"("guid");

-- One open job per asset: a double click (or two admins) must not encode the
-- same lesson twice into two versions racing for the row.
CREATE UNIQUE INDEX "media_audio_migration_jobs_open_guid_key"
  ON "media_audio_migration_jobs"("guid")
  WHERE "status" IN ('REQUESTED', 'PROCESSING');
