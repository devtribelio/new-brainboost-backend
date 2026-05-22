-- AlterTable: per-purchase commission override (link used at checkout)
ALTER TABLE "commerce_transactions" ADD COLUMN "attributedAffiliatorMemberId" UUID;
