-- Tracking links for promo landing pages (`/promo/{slug}`).
--
-- A promo covers several products, so a promo link has no single product: the
-- link now targets EITHER a product OR a promo. The CHECK keeps that exclusive —
-- a row with both would leave the shortlink redirect guessing, and a row with
-- neither has nowhere to send the visitor.
--
-- No FK to `promos`, same rule as `product_id`: a campaign that happened is a
-- record, and deleting a promo must neither fail nor erase the link's history.
ALTER TABLE "tracking_links" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "tracking_links" ADD COLUMN "promo_id" UUID;
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_target_check"
  CHECK (num_nonnulls("product_id", "promo_id") = 1);

CREATE INDEX "tracking_links_promo_id_idx" ON "tracking_links"("promo_id");
