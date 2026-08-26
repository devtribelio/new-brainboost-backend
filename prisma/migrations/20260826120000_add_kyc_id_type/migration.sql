-- Document kind behind members.kyc_id_number, written together with the number by
-- the Didit webhook path (docs/kyc-didit.md §Document number). Stored verbatim as
-- the provider labels it, so no CHECK / enum here. Nullable + no backfill: existing
-- rows keep NULL until the one-shot `pnpm kyc:backfill-didit-id` fills them.

ALTER TABLE "members" ADD COLUMN "kyc_id_type" TEXT;
