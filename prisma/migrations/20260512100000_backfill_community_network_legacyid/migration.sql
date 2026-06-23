-- Backfill legacyId on community-purpose networks (BB-TIMELINE, BB-EDUCATION).
--
-- These rows were inserted by 20260511033000_seed_community_networks without
-- `legacyId`, so /api/member/info emitted `community[].networkId` as a UUID
-- string (falling back from null legacyId). Mobile FE InfoModel.fromJson had
-- to coerce string→int defensively (FE commit `dbc63de`, 2026-05-12 — historical
-- prod hang from uncaught TypeError).
--
-- Use high reserved ints to avoid collision with anything imported from legacy
-- (legacy network_id ranges are positive ints, typically < 100k).
--
-- Idempotent: only sets when currently null. Re-applying is a no-op.

UPDATE "networks"
SET    "legacyId" = 999000001
WHERE  "code" = 'BB-TIMELINE'
  AND  "legacyId" IS NULL;

UPDATE "networks"
SET    "legacyId" = 999000002
WHERE  "code" = 'BB-EDUCATION'
  AND  "legacyId" IS NULL;
