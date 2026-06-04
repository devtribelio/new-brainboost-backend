-- AddColumn: attribution_context JSONB to pra_members
-- Safe, nullable column — no backfill required.
ALTER TABLE "pra_members" ADD COLUMN "attribution_context" JSONB;
