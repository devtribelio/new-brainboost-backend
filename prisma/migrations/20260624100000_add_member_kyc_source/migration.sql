-- Provenance flag for kycStatus. Distinguishes legacy-imported KYC (no Sumsub
-- applicant, images in legacy S3) from MANUAL / SUMSUB flows in the new system.
ALTER TABLE "members" ADD COLUMN "kyc_source" TEXT NOT NULL DEFAULT 'NONE';
