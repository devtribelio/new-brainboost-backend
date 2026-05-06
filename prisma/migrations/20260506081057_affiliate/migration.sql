-- CreateEnum
CREATE TYPE "AffiliateRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "affiliate_program_categories" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_program_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_programs" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "networkId" TEXT,
    "productId" TEXT,
    "categoryId" TEXT,
    "name" TEXT,
    "commissionType" TEXT NOT NULL DEFAULT 'percent',
    "commissionAmount" INTEGER NOT NULL DEFAULT 0,
    "pbsCommissionType" TEXT NOT NULL DEFAULT 'PERCENT',
    "pbsAff1" INTEGER NOT NULL DEFAULT 20,
    "pbsAff2" INTEGER NOT NULL DEFAULT 30,
    "pbsAff3" INTEGER NOT NULL DEFAULT 40,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_requests" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "programId" TEXT,
    "memberId" TEXT,
    "inviterId" TEXT,
    "email" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "fromSource" TEXT,
    "invitedType" TEXT,
    "tags" TEXT,
    "reqStatus" "AffiliateRequestStatus" NOT NULL DEFAULT 'PENDING',
    "actionAt" TIMESTAMP(3),
    "actionBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_affiliators" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "memberId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "requestId" TEXT,
    "exitState" TEXT,
    "exitAt" TIMESTAMP(3),
    "fbPixelId" TEXT,
    "ttPixelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_affiliators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_commissions" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "recipientId" TEXT NOT NULL,
    "affiliatorId" TEXT,
    "programId" TEXT,
    "productId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "productPrice" INTEGER NOT NULL DEFAULT 0,
    "commissionType" TEXT NOT NULL DEFAULT 'percent',
    "commissionAmount" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "feePercent" INTEGER NOT NULL DEFAULT 0,
    "feeAmount" INTEGER NOT NULL DEFAULT 0,
    "isPending" BOOLEAN NOT NULL DEFAULT false,
    "isExpired" BOOLEAN NOT NULL DEFAULT false,
    "isSuper" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "paymentLegacyId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_program_categories_legacyId_key" ON "affiliate_program_categories"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_programs_legacyId_key" ON "affiliate_programs"("legacyId");

-- CreateIndex
CREATE INDEX "affiliate_programs_networkId_idx" ON "affiliate_programs"("networkId");

-- CreateIndex
CREATE INDEX "affiliate_programs_productId_idx" ON "affiliate_programs"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_requests_legacyId_key" ON "affiliate_requests"("legacyId");

-- CreateIndex
CREATE INDEX "affiliate_requests_programId_idx" ON "affiliate_requests"("programId");

-- CreateIndex
CREATE INDEX "affiliate_requests_memberId_idx" ON "affiliate_requests"("memberId");

-- CreateIndex
CREATE INDEX "affiliate_requests_email_idx" ON "affiliate_requests"("email");

-- CreateIndex
CREATE UNIQUE INDEX "member_affiliators_legacyId_key" ON "member_affiliators"("legacyId");

-- CreateIndex
CREATE INDEX "member_affiliators_programId_idx" ON "member_affiliators"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "member_affiliators_memberId_programId_key" ON "member_affiliators"("memberId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commissions_legacyId_key" ON "affiliate_commissions"("legacyId");

-- CreateIndex
CREATE INDEX "affiliate_commissions_recipientId_idx" ON "affiliate_commissions"("recipientId");

-- CreateIndex
CREATE INDEX "affiliate_commissions_programId_idx" ON "affiliate_commissions"("programId");

-- CreateIndex
CREATE INDEX "affiliate_commissions_productId_idx" ON "affiliate_commissions"("productId");

-- AddForeignKey
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "affiliate_program_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_requests" ADD CONSTRAINT "affiliate_requests_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_requests" ADD CONSTRAINT "affiliate_requests_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_affiliators" ADD CONSTRAINT "member_affiliators_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_affiliators" ADD CONSTRAINT "member_affiliators_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_affiliatorId_fkey" FOREIGN KEY ("affiliatorId") REFERENCES "member_affiliators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

