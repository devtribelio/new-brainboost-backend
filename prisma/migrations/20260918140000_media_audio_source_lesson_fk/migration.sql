-- "Whose asset is this?" — an informational FK from media_audio_sources to the
-- lesson that carries the guid in its slides_data.
--
-- Nullable and ON DELETE SET NULL on purpose: the runtime lookup in
-- /media/hls is by `guid` (that is what the media token carries), never by
-- this column, so it can only inform an operator, never gate a request. One
-- Bunny asset may be referenced by several lessons; this column records the
-- one the operator meant (the first match at insert time), and the view
-- media_audio_source_lessons keeps computing the full truth from slides_data.
ALTER TABLE "media_audio_sources" ADD COLUMN "lesson_id" UUID;

ALTER TABLE "media_audio_sources"
  ADD CONSTRAINT "media_audio_sources_lesson_id_fkey"
  FOREIGN KEY ("lesson_id") REFERENCES "course_lessons"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "media_audio_sources_lesson_id_idx" ON "media_audio_sources"("lesson_id");

-- Backfill rows created before this column existed.
UPDATE "media_audio_sources" s
SET "lesson_id" = (
  SELECT l.id
  FROM "course_lessons" l
  WHERE jsonb_typeof(l.slides_data) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(l.slides_data) e
      WHERE e->'data'->>'guid' = s.guid
         OR e->'data'->'audio'->>'guid' = s.guid
         OR e->'data'->'video'->>'guid' = s.guid
    )
  ORDER BY l.created_at
  LIMIT 1
)
WHERE s."lesson_id" IS NULL;

-- The view gains the stored lesson_id next to the computed one, so a mismatch
-- is visible in one SELECT.
CREATE OR REPLACE VIEW "media_audio_source_lessons" AS
SELECT
  s.id            AS source_id,
  s.guid,
  s.audio_key,
  s.is_active,
  s.codec,
  s.duration_sec  AS source_duration_sec,
  s.lesson_id     AS stored_lesson_id,
  p.id            AS product_id,
  p.title         AS product_title,
  c.id            AS course_id,
  l.id            AS lesson_id,
  l.name          AS lesson_name,
  l.duration      AS lesson_duration_sec,
  l.is_preview,
  (s.lesson_id IS NOT DISTINCT FROM l.id) AS stored_matches
FROM "media_audio_sources" s
LEFT JOIN "course_lessons" l
  ON jsonb_typeof(l.slides_data) = 'array'
 AND EXISTS (
   SELECT 1 FROM jsonb_array_elements(l.slides_data) e
   WHERE e->'data'->>'guid' = s.guid
      OR e->'data'->'audio'->>'guid' = s.guid
      OR e->'data'->'video'->>'guid' = s.guid
 )
LEFT JOIN "course_sections" sec ON sec.id = l.section_id
LEFT JOIN "courses" c ON c.id = sec.course_id
LEFT JOIN "products" p ON p.id = c.product_id;
