-- Terms & conditions acceptance.
--
-- `member_terms_acceptances` is the proof of consent: one append-only row per
-- (member, terms version). Re-accepting the same version hits the unique and is a
-- no-op; a new document version is a new row, so the history survives every bump.
-- No IP column on purpose: behind Cloudflare `req.ip` is the edge, not the visitor,
-- so it would be noise AND PII — without it the account purge never touches this table.
--
-- `members.terms_version` / `terms_accepted_at` cache the latest row for the read path
-- (profile payload), the same split as members.kyc* vs kyc_event. NULL = never accepted.
-- The version is a free-form label compared for equality with app_settings
-- `terms.currentVersion`; it is NOT semver. See docs/terms-acceptance.md.
ALTER TABLE "members" ADD COLUMN "terms_version" TEXT;
ALTER TABLE "members" ADD COLUMN "terms_accepted_at" TIMESTAMP(3);

CREATE TABLE "member_terms_acceptances" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "terms_version" TEXT NOT NULL,
    "app_version" TEXT,
    "platform" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_terms_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "member_terms_acceptances_member_id_terms_version_key"
  ON "member_terms_acceptances"("member_id", "terms_version");

CREATE INDEX "member_terms_acceptances_member_id_accepted_at_idx"
  ON "member_terms_acceptances"("member_id", "accepted_at");

ALTER TABLE "member_terms_acceptances" ADD CONSTRAINT "member_terms_acceptances_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
