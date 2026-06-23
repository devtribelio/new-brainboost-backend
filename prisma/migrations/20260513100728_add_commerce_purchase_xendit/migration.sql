-- CreateEnum
CREATE TYPE "CommerceTransactionStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CommercePaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'EXPIRED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "commerce_transactions" (
    "id" UUID NOT NULL,
    "legacyId" INTEGER,
    "code" TEXT NOT NULL,
    "memberId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "itemTotal" INTEGER NOT NULL DEFAULT 0,
    "shippingTotal" INTEGER NOT NULL DEFAULT 0,
    "feeTotal" INTEGER NOT NULL DEFAULT 0,
    "voucherAmount" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "voucherCode" TEXT,
    "voucherId" UUID,
    "affiliatorId" UUID,
    "programId" UUID,
    "status" "CommerceTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payments" (
    "id" UUID NOT NULL,
    "legacyId" INTEGER,
    "transactionId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "paymentType" TEXT NOT NULL,
    "bank" TEXT,
    "ewalletType" TEXT,
    "amount" INTEGER NOT NULL,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "acceptedAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "CommercePaymentStatus" NOT NULL DEFAULT 'PENDING',
    "vendorStatus" TEXT,
    "externalId" TEXT,
    "xenditId" TEXT,
    "xenditVaId" TEXT,
    "vaNumber" TEXT,
    "cardTokenId" TEXT,
    "cardMaskedNumber" TEXT,
    "cardBrand" TEXT,
    "expiredAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "logRequest" JSONB,
    "logResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payment_events" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "fromStatus" "CommercePaymentStatus",
    "toStatus" "CommercePaymentStatus" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "legacyId" INTEGER,
    "code" TEXT NOT NULL,
    "productId" UUID,
    "type" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "maxAmount" INTEGER,
    "quota" INTEGER,
    "used" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_transactions_legacyId_key" ON "commerce_transactions"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_transactions_code_key" ON "commerce_transactions"("code");

-- CreateIndex
CREATE INDEX "commerce_transactions_memberId_createdAt_idx" ON "commerce_transactions"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_transactions_status_idx" ON "commerce_transactions"("status");

-- CreateIndex
CREATE INDEX "commerce_transactions_expiredAt_idx" ON "commerce_transactions"("expiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payments_legacyId_key" ON "commerce_payments"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payments_xenditId_key" ON "commerce_payments"("xenditId");

-- CreateIndex
CREATE INDEX "commerce_payments_transactionId_idx" ON "commerce_payments"("transactionId");

-- CreateIndex
CREATE INDEX "commerce_payments_status_expiredAt_idx" ON "commerce_payments"("status", "expiredAt");

-- CreateIndex
CREATE INDEX "commerce_payment_events_paymentId_createdAt_idx" ON "commerce_payment_events"("paymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_legacyId_key" ON "vouchers"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");

-- AddForeignKey
ALTER TABLE "commerce_transactions" ADD CONSTRAINT "commerce_transactions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_transactions" ADD CONSTRAINT "commerce_transactions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_transactions" ADD CONSTRAINT "commerce_transactions_affiliatorId_fkey" FOREIGN KEY ("affiliatorId") REFERENCES "member_affiliators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_transactions" ADD CONSTRAINT "commerce_transactions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_transactions" ADD CONSTRAINT "commerce_transactions_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payments" ADD CONSTRAINT "commerce_payments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "commerce_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payments" ADD CONSTRAINT "commerce_payments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payment_events" ADD CONSTRAINT "commerce_payment_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "commerce_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
