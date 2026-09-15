-- Visits to an event page, deliberately NOT rows in `shop_visits`.
--
-- A nullable `event_id` on the shop table would be isolated only by accident:
-- nothing reads `shop_visits` today, so nothing leaks today, but the first
-- marketing report built on it would sweep event rows in unless its author
-- remembered to filter. A separate table makes the mixing impossible.
--
-- No foreign keys, same rule as shop_visits and affiliate_visits: written by a
-- public unauthenticated endpoint that must never fail, and a FK violation there
-- turns a marketing click into a lost row.
CREATE TABLE "event_visits" (
    "id" UUID NOT NULL,
    "guest_id" TEXT NOT NULL,
    "member_id" UUID,
    "event_id" UUID,
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

    CONSTRAINT "event_visits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_visits_client_event_id_key" ON "event_visits"("client_event_id");
CREATE INDEX "event_visits_guest_id_created_at_idx" ON "event_visits"("guest_id", "created_at");
CREATE INDEX "event_visits_member_id_idx" ON "event_visits"("member_id");
CREATE INDEX "event_visits_event_id_created_at_idx" ON "event_visits"("event_id", "created_at");
CREATE INDEX "event_visits_utm_source_utm_campaign_created_at_idx" ON "event_visits"("utm_source", "utm_campaign", "created_at");
