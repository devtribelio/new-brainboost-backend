-- Provenance of members.inviter_id, so the legacy tree resync stops overwriting an
-- inviter the new app set (register / affiliate connect), including to NULL.
--   'LEGACY_PARENT'  = written by the tree resync from member_network.parent_id
--   'LEGACY_CONNECT' = reserved for the legacy affiliate-connect sync
--   'APP'            = written by the new app
--   NULL             = no inviter, or provenance unknown
-- The tree resync only writes over NULL / 'LEGACY_PARENT'. Plain string, no enum.
ALTER TABLE "members" ADD COLUMN "inviter_source" TEXT;

-- Backfill. Plain UPDATEs leave updated_at alone (@updatedAt is Prisma-client-side).
-- A member with no legacy row can only have been given an inviter by the new app.
UPDATE "members" SET "inviter_source" = 'APP'
 WHERE "legacy_id" IS NULL AND "inviter_id" IS NOT NULL;
-- Migrated members: the inviter came from the legacy tree (migration or resync).
UPDATE "members" SET "inviter_source" = 'LEGACY_PARENT'
 WHERE "legacy_id" IS NOT NULL AND "inviter_id" IS NOT NULL;
