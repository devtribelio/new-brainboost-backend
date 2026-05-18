-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "clientType" TEXT NOT NULL DEFAULT 'mobile';

-- CreateIndex
CREATE INDEX "refresh_tokens_memberId_clientType_revokedAt_idx" ON "refresh_tokens"("memberId", "clientType", "revokedAt");
