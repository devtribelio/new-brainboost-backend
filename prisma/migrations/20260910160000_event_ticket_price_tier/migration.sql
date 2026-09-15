-- Bundle pricing per ticket kind: "from 2 tickets, 350k total".
--
-- A package is presentation; the quantity is the reality. Trio + 1 Solo is one
-- order of qty 4 of ONE ticket kind, priced through this ladder — not a product
-- of its own. A package-as-product would have to yield three tickets from one
-- unit, would count quota wrong, and a mixed basket would force a multi-line
-- order, which commerce_transactions cannot express.
--
-- No row for qty 1: that price is products.price, which stays the single source
-- of truth. A kind with no rows here behaves exactly as it did before bundling.
--
-- ON DELETE CASCADE: a ladder belongs to its kind and means nothing without it,
-- and the kind is already undeletable once anything has been sold.
CREATE TABLE "event_ticket_price_tiers" (
    "id" UUID NOT NULL,
    "ticket_type_id" UUID NOT NULL,
    "min_qty" INTEGER NOT NULL,
    "total_price" INTEGER NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_ticket_price_tiers_pkey" PRIMARY KEY ("id")
);

-- One tier per quantity per kind. Two rows for the same minQty would make the
-- price depend on row order.
CREATE UNIQUE INDEX "event_ticket_price_tiers_ticket_type_id_min_qty_key"
    ON "event_ticket_price_tiers"("ticket_type_id", "min_qty");

ALTER TABLE "event_ticket_price_tiers"
    ADD CONSTRAINT "event_ticket_price_tiers_ticket_type_id_fkey"
    FOREIGN KEY ("ticket_type_id") REFERENCES "event_ticket_types"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
