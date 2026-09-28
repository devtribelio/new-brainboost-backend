-- First-purchase voucher program: a voucher row that belongs to one member.
--
-- Additive, no downtime, no backfill: every existing row keeps NULL in all four
-- columns, which is exactly "a public code authored by ops" — the behaviour they
-- have today.
ALTER TABLE "vouchers"
  ADD COLUMN "owner_member_id" UUID,
  ADD COLUMN "campaign"        TEXT,
  ADD COLUMN "owner_source"    TEXT,
  ADD COLUMN "sent_channel"    TEXT;

-- One automated voucher per member per program, for life.
--
-- Plain UNIQUE, not `... WHERE owner_member_id IS NOT NULL`: Postgres treats NULLs
-- as distinct inside a unique index, so an unbounded number of ops rows (owner NULL,
-- campaign NULL) still fits. The partial form would buy nothing and could not be
-- expressed in schema.prisma, leaving permanent `migrate diff` drift.
CREATE UNIQUE INDEX "vouchers_owner_member_id_campaign_key"
  ON "vouchers" ("owner_member_id", "campaign");

-- Serves the backoffice report: issued-per-month, per campaign.
CREATE INDEX "vouchers_campaign_created_at_idx" ON "vouchers" ("campaign", "created_at");
