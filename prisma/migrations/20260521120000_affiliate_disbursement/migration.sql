-- CreateTable
CREATE TABLE "affiliate_disbursements" (
    "id" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "grossAmount" INTEGER NOT NULL DEFAULT 0,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "netAmount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "providerRef" TEXT,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "affiliate_disbursements_memberId_status_idx" ON "affiliate_disbursements"("memberId", "status");

-- CreateIndex
CREATE INDEX "affiliate_disbursements_status_idx" ON "affiliate_disbursements"("status");

-- AddForeignKey
ALTER TABLE "affiliate_disbursements" ADD CONSTRAINT "affiliate_disbursements_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
