-- Affiliate over-attribution fix (B-2). See docs/affiliate-overattribution-fix.md.
-- Additive only: a nullable audit column on commerce_transactions + one new table.
-- Apply with `prisma migrate deploy` (NEVER `migrate dev` on a populated DB — bo_* drift).

-- Commission idempotency key — stable across re-settles (Apple original_transaction_id).
-- Audit/forensics + lets the cleanup job map a stray commission back to its purchase.
ALTER TABLE "commerce_transactions" ADD COLUMN "attribution_key" TEXT;

-- "first settle wins" claim: one row per underlying purchase. The unique
-- (provider, attribution_key) makes commission attribution idempotent across
-- delete+rebuy / renewal / restore / RC re-sync bursts — only the first settle
-- inserts and pays commission; later settles get enrollment only (no double-pay).
CREATE TABLE "affiliate_attribution_claims" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "attribution_key" TEXT NOT NULL,
    "payment_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_attribution_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "affiliate_attribution_claims_provider_attribution_key_key" ON "affiliate_attribution_claims"("provider", "attribution_key");
