-- AlterTable: add payment channel tag to affiliate_commissions
ALTER TABLE "affiliate_commissions" ADD COLUMN "channel" TEXT;

-- CreateIndex: support per-channel cron query
CREATE INDEX "affiliate_commissions_status_channel_idx" ON "affiliate_commissions"("status", "channel");
