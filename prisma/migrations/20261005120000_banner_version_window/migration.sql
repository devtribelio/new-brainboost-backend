-- Per-banner app version window, one pair per platform, both bounds INCLUSIVE.
-- NULL (or empty) = unbounded; all four NULL = the banner is shown as before, so
-- every existing row is unaffected. A banner with any bound set is shown only to a
-- client that sends ?platform=android|ios&version= inside its platform's window —
-- a request without them (web, or an app build older than the banner gate) does
-- not see it. Lets a banner run on prod for an unreleased internal build only.
-- No CHECK on the format: an unparseable value fails closed (banner hidden).
ALTER TABLE "banners" ADD COLUMN "min_version_android" TEXT;
ALTER TABLE "banners" ADD COLUMN "max_version_android" TEXT;
ALTER TABLE "banners" ADD COLUMN "min_version_ios" TEXT;
ALTER TABLE "banners" ADD COLUMN "max_version_ios" TEXT;
