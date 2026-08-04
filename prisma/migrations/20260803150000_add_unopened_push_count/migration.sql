-- Push-fatigue counter: how many push have been sent since the member last
-- opened the app. Reset to 0 on app resume (/member/info) and /notification/seen.
-- NOT NULL DEFAULT <const> is metadata-only on PG11+, so no table rewrite.
ALTER TABLE "members" ADD COLUMN "unopened_push_count" INTEGER NOT NULL DEFAULT 0;
