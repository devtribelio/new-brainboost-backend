-- Provenance of members.affiliate_based, so the legacy tree resync stops reverting the
-- affiliate mode a member chose in the app (audit 08 F8).
--   'LEGACY' = migration / tree resync (member_network.affiliate_based)
--   'APP'    = member switched mode in the app (AffiliatorService.setMode)
--   NULL     = unknown
-- The tree resync may only write over NULL / 'LEGACY'. Plain string, no enum.
ALTER TABLE "members" ADD COLUMN "affiliate_based_source" TEXT;

-- Backfill. Migrated members got their mode from legacy; a member with no legacy row can
-- only have been given a mode by the new app. History cannot tell a past app switch on a
-- migrated member (there was no marker), so those stay LEGACY and may be re-applied once.
UPDATE "members" SET "affiliate_based_source" = 'LEGACY' WHERE "legacy_id" IS NOT NULL;
UPDATE "members" SET "affiliate_based_source" = 'APP' WHERE "legacy_id" IS NULL;
