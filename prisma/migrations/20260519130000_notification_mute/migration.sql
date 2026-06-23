-- CreateTable
CREATE TABLE "notification_mutes" (
    "memberId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_mutes_pkey" PRIMARY KEY ("memberId", "scope", "refId")
);

-- CreateIndex
CREATE INDEX "notification_mutes_scope_refId_idx" ON "notification_mutes"("scope", "refId");

-- AddForeignKey
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
