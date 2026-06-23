-- Phone-register no longer synthesizes a placeholder email; email is NULL until
-- the member sets a real one. Postgres unique index treats NULLs as distinct,
-- so any number of email-less members coexist.
ALTER TABLE "members" ALTER COLUMN "email" DROP NOT NULL;

-- Null out the synthetic placeholders minted by the old phone-register
-- (SYNTHETIC_EMAIL_DOMAIN, removed from member-state.util).
UPDATE "members" SET "email" = NULL WHERE "email" LIKE '%@phone.brainboost.local';
