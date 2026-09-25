-- Default split goes from 12 to 120 parts per audio.
--
-- 12 was chosen to fit ONE downloader batch of the store app, on the theory that
-- MIUI/HyperOS kills the app between batches. Tested on staging 2026-09-22 with a
-- POCO on a 1 Mbit/s link, screen locked from the first second: 119 parts (10
-- batches on app 3.3.3) downloaded in ~9 minutes without a stall. What 12 costs
-- is visible to members: the app draws progress as parts done / total, so a slow
-- download sat at 0% and jumped in 8% steps ("looks stuck"). 120 moves it ~1% at
-- a time, with no app release, and a failed part retries ~0.5 MB instead of ~5.
--
-- Still far below Bunny's ~900 x 4-second segments (~75 batches), which is what
-- failed. Upper bound 200 leaves room without inviting another Bunny.
-- Existing rows are untouched: a stored audio keeps its parts until re-cut
-- ("Migrasi ke S3" again). Back to 12 = `ALTER COLUMN parts SET DEFAULT 12`.
ALTER TABLE "media_audio_migration_jobs" DROP CONSTRAINT IF EXISTS "media_audio_migration_jobs_parts_check";
ALTER TABLE "media_audio_migration_jobs"
  ADD CONSTRAINT "media_audio_migration_jobs_parts_check" CHECK ("parts" BETWEEN 1 AND 200);
ALTER TABLE "media_audio_migration_jobs" ALTER COLUMN "parts" SET DEFAULT 120;
