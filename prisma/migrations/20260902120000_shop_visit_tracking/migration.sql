-- Tracking-link attribution for the shop web (webinar links).
-- Two independent pieces: a visit table, and a frozen source snapshot on orders.

-- 1) Visit log. No FK to members/products on purpose: this is a reporting table
--    written by a public, unauthenticated endpoint that must never fail, and a
--    FK violation there would turn a marketing click into a lost row.
CREATE TABLE "shop_visits" (
    "id" UUID NOT NULL,
    "guest_id" TEXT NOT NULL,
    "member_id" UUID,
    "product_id" UUID,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "referer" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "client_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_visits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_visits_client_event_id_key" ON "shop_visits"("client_event_id");
CREATE INDEX "shop_visits_guest_id_created_at_idx" ON "shop_visits"("guest_id", "created_at");
CREATE INDEX "shop_visits_member_id_idx" ON "shop_visits"("member_id");
CREATE INDEX "shop_visits_utm_source_utm_campaign_created_at_idx" ON "shop_visits"("utm_source", "utm_campaign", "created_at");
CREATE INDEX "shop_visits_created_at_idx" ON "shop_visits"("created_at");

-- 2) Order-side snapshot. Frozen at checkout; never updated. Reporting only —
--    these columns must never feed commission math.
ALTER TABLE "commerce_transactions" ADD COLUMN "utm_source" TEXT;
ALTER TABLE "commerce_transactions" ADD COLUMN "utm_medium" TEXT;
ALTER TABLE "commerce_transactions" ADD COLUMN "utm_campaign" TEXT;
ALTER TABLE "commerce_transactions" ADD COLUMN "utm_content" TEXT;
ALTER TABLE "commerce_transactions" ADD COLUMN "utm_term" TEXT;
ALTER TABLE "commerce_transactions" ADD COLUMN "guest_id" TEXT;

CREATE INDEX "commerce_transactions_utm_source_utm_campaign_created_at_idx" ON "commerce_transactions"("utm_source", "utm_campaign", "created_at");
