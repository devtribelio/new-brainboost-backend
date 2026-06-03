-- Rename store-SKU column: iap_product_id was App-Store-only despite the generic name.
-- Split into explicit per-store SKUs so iOS and Android RevenueCat product_ids resolve independently.
ALTER TABLE "products" RENAME COLUMN "iap_product_id" TO "ios_product_id";

-- The unique index follows the column rename automatically in Postgres, but its name
-- still references the old column. Rename for clarity (no-op on behavior).
ALTER INDEX IF EXISTS "products_iap_product_id_key" RENAME TO "products_ios_product_id_key";

-- New Play-Store SKU column, nullable, unique (NULLs distinct → many products without an Android SKU).
ALTER TABLE "products" ADD COLUMN "android_product_id" TEXT;
CREATE UNIQUE INDEX "products_android_product_id_key" ON "products" ("android_product_id");
