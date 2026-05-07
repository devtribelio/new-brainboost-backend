-- AlterTable
ALTER TABLE "members" ADD COLUMN "affiliateCode" TEXT,
ADD COLUMN "scheduledDeletionAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "pra_members" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "affiliateMemberId" TEXT,
    "networkId" TEXT,
    "device" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pra_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "members_affiliateCode_key" ON "members"("affiliateCode");

-- CreateIndex
CREATE INDEX "pra_members_email_idx" ON "pra_members"("email");

-- CreateIndex
CREATE INDEX "pra_members_phone_idx" ON "pra_members"("phone");
