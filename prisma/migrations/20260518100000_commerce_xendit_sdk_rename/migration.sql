-- Commerce P7 — Xendit SDK PaymentRequest migration column renames.
-- cardTokenId became meaningless under the unified PaymentRequest model.
-- xenditVaId was VA-specific; under PaymentRequest the payment-method id (pm-...)
-- covers VA + eWallet + Card. Renamed for clarity.

ALTER TABLE "commerce_payments"
  RENAME COLUMN "xenditVaId" TO "xenditPaymentMethodId";

ALTER TABLE "commerce_payments"
  RENAME COLUMN "cardTokenId" TO "paymentMethodId";
