-- App-edit markers for the legacy members resync gate. Set ONLY by member-initiated app
-- edits (profile update → profile_updated_at; change/forgot/claim password →
-- password_updated_at). The resync used to gate on `updated_at > legacy_synced_at`, but
-- `updated_at` is Prisma @updatedAt and is bumped by every write (push counters,
-- last_active_at, the resync's own tree/kyc writes), so ~all migrated members read as
-- app-touched and legacy profile/password/reactivation stopped flowing.
ALTER TABLE "members" ADD COLUMN "profile_updated_at" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "password_updated_at" TIMESTAMP(3);

-- Backfill, conservative. History cannot tell a real app edit from bookkeeping, so:
--  * a legacy member who never opened the app (last_active_at NULL) cannot have edited
--    anything here → markers stay NULL → follows legacy (PRD acceptance).
--  * an app-active legacy member MAY have edited their profile → keep app ownership.
--  * password: every app writer stores bcrypt, so a non-bcrypt algo ('legacy'/md5,
--    sha1, sha256, 'social') cannot be an app password change → stays NULL. A bcrypt
--    hash on an app-active member is either the lazy login rehash (same password) or a
--    real app change/reset — we cannot tell which, so keep app ownership rather than
--    risk restoring an old hash.
-- Non-legacy rows are never resynced, so they stay NULL.
UPDATE "members"
   SET "profile_updated_at" = "updated_at"
 WHERE "legacy_id" IS NOT NULL
   AND "last_active_at" IS NOT NULL;

UPDATE "members"
   SET "password_updated_at" = "updated_at"
 WHERE "legacy_id" IS NOT NULL
   AND "last_active_at" IS NOT NULL
   AND "password_algo" = 'bcrypt';
