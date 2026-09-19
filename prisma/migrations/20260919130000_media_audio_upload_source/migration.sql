-- Audio uploaded straight from the backoffice (never on Bunny).
--
-- The browser PUTs the raw file to `private/audio-uploads/<guid>/source.<ext>`
-- and the backoffice queues a job carrying that key. `source_key` on the job
-- tells `migrateAudioToStorage` to read the master from our bucket instead of
-- downloading the Bunny MP4; the same value is kept on the served row so ops
-- (and the backoffice) can tell an upload from a Bunny migration — an upload has
-- NO Bunny copy, so "back to Bunny" is not a rollback that exists for it.
-- NULL on both = the asset came from Bunny (every row before this column).
ALTER TABLE "media_audio_migration_jobs" ADD COLUMN "source_key" TEXT;
ALTER TABLE "media_audio_sources" ADD COLUMN "source_key" TEXT;
