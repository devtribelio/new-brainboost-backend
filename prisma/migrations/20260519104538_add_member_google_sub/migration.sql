-- AlterTable
ALTER TABLE "members" ADD COLUMN "googleSub" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "members_googleSub_key" ON "members"("googleSub");
