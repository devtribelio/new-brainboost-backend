-- Banner: how a tap opens `link_url`. 'external' = system browser (the behaviour
-- before this column, hence the default for every existing row); 'webview' =
-- in-app browser. Free text, no CHECK: the app treats any value it does not know
-- as 'external', so a later mode needs no migration.
ALTER TABLE "banners" ADD COLUMN "open_mode" TEXT NOT NULL DEFAULT 'external';

-- Promo landing page: slug + title + ONE voucher + an ordered product list.
-- No price column on purpose — the promo price is the voucher applied to
-- `products.price` at read time, the same arithmetic checkout runs.
-- Written by the backoffice over plain SQL: `id` and `updated_at` have no
-- Postgres default (both are Prisma-Client-side), so the writer supplies them.
CREATE TABLE "promos" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "voucher_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "promo_products" (
    "promo_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "promo_products_pkey" PRIMARY KEY ("promo_id","product_id")
);

CREATE UNIQUE INDEX "promos_slug_key" ON "promos"("slug");

ALTER TABLE "promos" ADD CONSTRAINT "promos_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promo_products" ADD CONSTRAINT "promo_products_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "promos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promo_products" ADD CONSTRAINT "promo_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
