-- Shortlink support for tracking links: a globally unique slug, and per-day
-- click counters.

-- 1) Slug. Added nullable, backfilled, then tightened - the table already has
--    rows in staging and a NOT NULL column with no default would refuse to add.
ALTER TABLE "tracking_links" ADD COLUMN "slug" TEXT;

-- Backfill from utm_campaign, which is what an operator would have typed anyway.
-- utm_campaign is unique only per (utm_source, utm_campaign), so a collision is
-- possible in principle; the suffix keeps the backfill total instead of leaving
-- a NULL that the NOT NULL below would reject.
UPDATE "tracking_links" l
SET "slug" = CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM "tracking_links" o
    WHERE o."utm_campaign" = l."utm_campaign" AND o.id <> l.id
  ) THEN l."utm_campaign"
  ELSE l."utm_campaign" || '-' || substr(replace(l.id::text, '-', ''), 1, 6)
END
WHERE "slug" IS NULL;

ALTER TABLE "tracking_links" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "tracking_links_slug_key" ON "tracking_links"("slug");

-- 2) Click counters, one row per (link, WIB day). Cascade on delete: a counter
--    for a link that no longer exists answers no question, and unlike the
--    report's numbers (which live on shop_visits / commerce_transactions and
--    must survive) this row IS the link's own data.
CREATE TABLE "tracking_link_clicks" (
    "link_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tracking_link_clicks_pkey" PRIMARY KEY ("link_id","day")
);

CREATE INDEX "tracking_link_clicks_day_idx" ON "tracking_link_clicks"("day");

ALTER TABLE "tracking_link_clicks"
  ADD CONSTRAINT "tracking_link_clicks_link_id_fkey"
  FOREIGN KEY ("link_id") REFERENCES "tracking_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
