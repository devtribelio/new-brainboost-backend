-- Force/soft update config for the mobile app: ONE ROW PER PLATFORM. Backs
-- `GET /api/app/version-check`, which replaces the app's Supabase `mobile_version_config`
-- AND its store-listing scrape — so this table is now the ONLY thing standing between a
-- typo and every user trapped behind a non-dismissible dialog. Hence the CHECK constraints
-- below: they are the guardrail, since ops edit these rows by hand (SQL / backoffice-bb).
-- NOTE: `updated_at` has no DB default (@updatedAt) — a raw-SQL writer must supply it.
CREATE TABLE "app_version_configs" (
    "platform" TEXT NOT NULL,
    "latest_version" TEXT NOT NULL,
    "force_below" TEXT,
    "store_url" TEXT,
    "soft_message" TEXT,
    "force_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_version_configs_pkey" PRIMARY KEY ("platform")
);

-- The client only ever sends these two.
ALTER TABLE "app_version_configs"
  ADD CONSTRAINT "app_version_configs_platform_check"
  CHECK ("platform" IN ('android', 'ios'));

-- Full 3-segment semver only. Rejects 'v3.3.0', '3.3', '3.3.0 ' — all of which would
-- otherwise parse into a silently wrong verdict.
ALTER TABLE "app_version_configs"
  ADD CONSTRAINT "app_version_configs_latest_version_check"
  CHECK ("latest_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

ALTER TABLE "app_version_configs"
  ADD CONSTRAINT "app_version_configs_force_below_check"
  CHECK ("force_below" IS NULL OR "force_below" ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

-- force_below must never exceed latest_version, otherwise users are forced onto a build
-- we don't even consider current. int[] comparison is element-wise, i.e. real semver
-- ordering (3.10.0 > 3.9.9), unlike a plain text compare.
ALTER TABLE "app_version_configs"
  ADD CONSTRAINT "app_version_configs_force_below_lte_latest_check"
  CHECK (
    "force_below" IS NULL
    OR string_to_array("force_below", '.')::int[] <= string_to_array("latest_version", '.')::int[]
  );
