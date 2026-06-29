-- Per-product affiliate attribution (B-5). See docs/affiliate-overattribution-fix.md.
-- Additive only: a nullable product_id on affiliate_visits + a lookup index.
-- Apply with `prisma migrate deploy`.

-- The product an affiliate link pointed at (OneLink = product + affCode). null =
-- product-less visit (web/program link, or legacy pre-B5). Scalar (no FK) — only
-- filtered on. Lets the per-purchase resolver prefer an exact-product visit so a
-- link for product X never attributes a different product Y.
ALTER TABLE "affiliate_visits" ADD COLUMN "product_id" UUID;

-- per-product last-touch lookup: WHERE member_id = ? AND product_id = ? ORDER BY created_at DESC
CREATE INDEX "affiliate_visits_member_id_product_id_created_at_idx" ON "affiliate_visits"("member_id", "product_id", "created_at");
