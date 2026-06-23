-- Affiliate disbursement: member bank account + manual KYC + payout approval/idempotency.
-- Hand-written (DB unreachable at migrate time). Mirrors schema.prisma changes for
-- Member + AffiliateDisbursement. All additive (nullable / defaulted) — safe on existing rows.

-- Member: default bank account (profile) + manual KYC fields
ALTER TABLE "members"
  ADD COLUMN "bank_code" TEXT,
  ADD COLUMN "bank_account_number" TEXT,
  ADD COLUMN "bank_account_name" TEXT,
  ADD COLUMN "kyc_status" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "kyc_id_number" TEXT,
  ADD COLUMN "kyc_id_card_url" TEXT,
  ADD COLUMN "kyc_selfie_url" TEXT,
  ADD COLUMN "kyc_submitted_at" TIMESTAMP(3),
  ADD COLUMN "kyc_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "kyc_reviewed_by" UUID,
  ADD COLUMN "kyc_rejected_reason" TEXT;

-- AffiliateDisbursement: routing mode, bank snapshot, approval audit, idempotency key
ALTER TABLE "affiliate_disbursements"
  ADD COLUMN "mode" TEXT,
  ADD COLUMN "external_id" TEXT,
  ADD COLUMN "bank_code" TEXT,
  ADD COLUMN "bank_account_number" TEXT,
  ADD COLUMN "bank_account_name" TEXT,
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "rejected_reason" TEXT;

-- external_id is the Xendit idempotency / callback-match key — must be unique.
CREATE UNIQUE INDEX "affiliate_disbursements_external_id_key" ON "affiliate_disbursements"("external_id");
