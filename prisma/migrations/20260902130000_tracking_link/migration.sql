-- Named tracking links for shop product pages, authored in the backoffice.
--
-- No FK to `products`: same rule as `shop_visits` and `affiliate_visits` — a
-- campaign that happened is a record, and deleting a product must neither fail
-- nor erase it. No FK on `created_by` either: it points at `bo_users`, a
-- backoffice-owned table outside this schema.
--
-- UNIQUE (utm_source, utm_campaign) is load-bearing, not hygiene: the Sumber
-- Traffic report groups on exactly that pair, so two links sharing it would
-- merge into one row and mix their numbers with nothing on screen to show it.
-- Inactive links stay in the constraint — their traffic remains in the report,
-- so their campaign must never be reused.
CREATE TABLE "tracking_links" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "utm_source" TEXT NOT NULL,
    "utm_medium" TEXT,
    "utm_campaign" TEXT NOT NULL,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "voucher_code" TEXT,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tracking_links_utm_source_utm_campaign_key" ON "tracking_links"("utm_source", "utm_campaign");
CREATE INDEX "tracking_links_product_id_idx" ON "tracking_links"("product_id");
CREATE INDEX "tracking_links_created_at_idx" ON "tracking_links"("created_at");
