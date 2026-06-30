-- Idempotency guard for voucher redemption: one row per order (CommerceTransaction)
-- that consumed the voucher. A redelivered commerce.payment.success can no longer
-- double-increment vouchers.used — the second redeem hits the unique(transaction_id).
CREATE TABLE "voucher_redemptions" (
    "id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "payment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_redemptions_pkey" PRIMARY KEY ("id")
);

-- One redemption per order — the idempotency guard.
CREATE UNIQUE INDEX "voucher_redemptions_transaction_id_key" ON "voucher_redemptions"("transaction_id");

CREATE INDEX "voucher_redemptions_voucher_id_idx" ON "voucher_redemptions"("voucher_id");
