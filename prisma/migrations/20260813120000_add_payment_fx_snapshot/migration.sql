-- FX snapshot on commerce_payments.
--
-- Why: RevenueCat sends `price_in_purchased_currency` in the BUYER's storefront currency.
-- The ingest layer used to store it as-is, so an A$39.99 purchase landed as amount = 40
-- and its affiliate commission as Rp5. Amounts are now normalised to IDR before write;
-- these columns keep the original figures plus the rate that produced the IDR value, so
-- every converted row stays reproducible and auditable after the live rate moves on.
--
-- All nullable: IDR purchases (the overwhelming majority) leave every FX column NULL.
--
-- NOTE on `currency DEFAULT 'IDR'`: on PostgreSQL 11+ a constant default is applied to
-- EXISTING rows too (without a table rewrite), so every historical payment starts reading
-- 'IDR'. That is correct for the Xendit rows and for IDR-storefront IAP, but WRONG for the
-- 9 foreign purchases repaired before this migration existed — their real currency lives in
-- `log_response.backfill`. `scripts/backfill-rc-currency.ts` copies that stamp into these
-- columns (`--apply`), so run it once after this migration to make the set consistent.

ALTER TABLE "commerce_payments"
  ADD COLUMN "currency"       TEXT DEFAULT 'IDR',
  ADD COLUMN "amount_local"   DECIMAL(18,4),
  ADD COLUMN "amount_usd"     DECIMAL(18,4),
  ADD COLUMN "fx_rate_idr"    DECIMAL(18,6),
  ADD COLUMN "fx_rate_source" TEXT;
