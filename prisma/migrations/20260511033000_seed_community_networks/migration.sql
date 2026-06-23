-- Seed the community networks the mobile MainPage joins on every load.
-- /api/member/info reads networks where purpose IN ('timeline','education'),
-- and the Flutter app uses the returned `networkCode` to call
-- POST /api/member/network/join. Without these rows the app falls back to
-- code="" and the join request 400s.
--
-- Idempotent: re-applying is a no-op (NOT-EXISTS guard on the unique `code`).

INSERT INTO "networks" ("id", "code", "name", "purpose", "isActive")
SELECT gen_random_uuid(), 'BB-TIMELINE', 'Brainboost Timeline', 'timeline', true
WHERE NOT EXISTS (SELECT 1 FROM "networks" WHERE "code" = 'BB-TIMELINE');

INSERT INTO "networks" ("id", "code", "name", "purpose", "isActive")
SELECT gen_random_uuid(), 'BB-EDUCATION', 'Brainboost Education', 'education', true
WHERE NOT EXISTS (SELECT 1 FROM "networks" WHERE "code" = 'BB-EDUCATION');
