-- is_verified only ever meant email verification (phone has is_phone_verified)
-- — rename so the column says so.
ALTER TABLE "members" RENAME COLUMN "is_verified" TO "is_email_verified";
