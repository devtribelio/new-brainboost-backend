-- Ops view: which product / course / lesson does each single-file audio source
-- belong to?
--
-- `media_audio_sources` cannot carry a foreign key: a lesson references its
-- media only INSIDE `course_lessons.slides_data` (a JSON array of slides, the
-- guid at `data.guid`, or `data.audio.guid` / `data.video.guid` on the other
-- slide shapes the serializer accepts), and one Bunny asset may be reused by
-- several lessons. This view resolves that relation at read time, so "what is
-- this row?" and "which lessons flip when I toggle is_active?" are one SELECT.
--
-- Not declared in schema.prisma (Prisma does not manage views here); it is
-- read-only and may be dropped/recreated freely.
CREATE OR REPLACE VIEW "media_audio_source_lessons" AS
SELECT
  s.id            AS source_id,
  s.guid,
  s.audio_key,
  s.is_active,
  s.codec,
  s.duration_sec  AS source_duration_sec,
  p.id            AS product_id,
  p.title         AS product_title,
  c.id            AS course_id,
  l.id            AS lesson_id,
  l.name          AS lesson_name,
  l.duration      AS lesson_duration_sec,
  l.is_preview
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
