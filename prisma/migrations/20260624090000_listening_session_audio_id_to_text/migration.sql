-- AlterTable: audio_id is now an opaque string (Lesson id, no UUID constraint).
-- USING cast is required because Postgres has no implicit uuid → text conversion
-- in ALTER COLUMN TYPE.
ALTER TABLE "listening_session" ALTER COLUMN "audio_id" SET DATA TYPE TEXT USING "audio_id"::text;
