-- Sumsub applicant id bound to a member (externalUserId = member id).
ALTER TABLE "members" ADD COLUMN "sumsub_applicant_id" TEXT;

CREATE UNIQUE INDEX "members_sumsub_applicant_id_key" ON "members"("sumsub_applicant_id");
