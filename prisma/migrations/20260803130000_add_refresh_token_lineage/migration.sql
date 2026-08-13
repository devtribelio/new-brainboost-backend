-- Lineage pointer for refresh-token rotation: `superseded_by_id` holds the id of
-- the row that replaced this one. Filled ONLY by rotation, which is what lets the
-- grace window distinguish "died because it was rotated" (benign, replayable)
-- from "died because the session was ended" (logout / password change /
-- single-session kick — must still kick instantly).
--
-- Additive, nullable, no backfill: instant on Postgres, no table rewrite. The
-- UNIQUE index enforces that a child supersedes exactly one parent, which is the
-- second line of defence against a double rotation slipping past the gate.
ALTER TABLE "refresh_tokens" ADD COLUMN "superseded_by_id" UUID;

CREATE UNIQUE INDEX "refresh_tokens_superseded_by_id_key" ON "refresh_tokens"("superseded_by_id");
