-- Nightly topic digest.
--
-- notifications.topic_id: denormalised out of `payload` so the digest can group
-- unread rows per topic with an indexed query instead of a JSON path scan.
-- Existing rows stay NULL — they are already-delivered history, not digest input.
ALTER TABLE "notifications" ADD COLUMN "topic_id" UUID;

-- Digest sweep predicate: type + read_at + topic_id.
CREATE INDEX "notifications_type_read_at_topic_id_idx"
  ON "notifications" ("type", "read_at", "topic_id");

-- Per-member watermark: only posts newer than this are counted, so a member is
-- never told twice about the same post. NULL = never digested.
ALTER TABLE "members" ADD COLUMN "last_topic_digest_at" TIMESTAMP(3);
