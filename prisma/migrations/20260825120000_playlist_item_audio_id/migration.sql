-- A playlist item points at a SLIDE, not at a lesson — and carries the same column
-- name as the listening log, `audio_id`, because it is the same id space.
--
-- `listening_session.audio_id` — the only other place in the system that refers to
-- an audio — has always carried the slide id from `course_lessons.slides_data`
-- (verified on 148,644 rows: zero match a Lesson.id). Keying playlist items the
-- same way lets an item and the listening it produced be joined, and lets a lesson
-- holding more than one playable slide be addressed precisely.
--
-- The name is imprecise (9% of tracked slides are VideoTemplate — a Bunny "audio"
-- is a video of a still image), but it is the name the log has always used, and a
-- second name for the same value would mislead more than a shared imprecise one.
--
-- `lesson_id` stays, denormalised, because a slide id lives inside JSON and cannot
-- carry a foreign key: it is what keeps ON DELETE CASCADE working and what keeps
-- the section → course lookup (entitlement, title, duration) a join.
--
-- NOT NULL with no default is safe: the table is empty in every environment — the
-- feature has never been released.

ALTER TABLE "playlist_items" ADD COLUMN "audio_id" TEXT NOT NULL;

DROP INDEX IF EXISTS "playlist_items_playlist_id_lesson_id_key";

CREATE UNIQUE INDEX "playlist_items_playlist_id_audio_id_key"
  ON "playlist_items"("playlist_id", "audio_id");

CREATE INDEX "playlist_items_lesson_id_idx" ON "playlist_items"("lesson_id");
