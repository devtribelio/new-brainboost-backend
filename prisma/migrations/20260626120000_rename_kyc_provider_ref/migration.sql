-- Rename the provider verification reference column from the Sumsub-specific name
-- to a provider-agnostic one (KYC provider switched Sumsub -> Didit). Non-destructive
-- rename: preserves any existing values and the unique constraint.
ALTER TABLE "members" RENAME COLUMN "sumsub_applicant_id" TO "kyc_provider_ref";
ALTER INDEX "members_sumsub_applicant_id_key" RENAME TO "members_kyc_provider_ref_key";
