-- Voucher product scope: single nullable product_id -> voucher_products junction.
-- Semantics: 0 junction rows = global voucher (was product_id IS NULL);
--            >=1 rows = whitelist (was product_id = X, now 1..N products).

CREATE TABLE "voucher_products" (
    "voucher_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,

    CONSTRAINT "voucher_products_pkey" PRIMARY KEY ("voucher_id", "product_id")
);

ALTER TABLE "voucher_products"
    ADD CONSTRAINT "voucher_products_voucher_id_fkey"
    FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voucher_products"
    ADD CONSTRAINT "voucher_products_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every product-scoped voucher becomes a 1-row whitelist.
INSERT INTO "voucher_products" ("voucher_id", "product_id")
SELECT "id", "product_id" FROM "vouchers" WHERE "product_id" IS NOT NULL;

ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "vouchers_product_id_fkey";
ALTER TABLE "vouchers" DROP COLUMN "product_id";
