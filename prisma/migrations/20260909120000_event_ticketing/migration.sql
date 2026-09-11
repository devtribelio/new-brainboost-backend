-- Event ticketing: events, their sellable ticket kinds, and the seats sold.
-- Purely additive — no existing table is altered. See docs/event-ticketing.md.
--
-- Unlike `tracking_links` / `shop_visits` / `affiliate_visits`, these tables DO
-- carry foreign keys. Those three are written by public endpoints that must
-- never fail (or point at backoffice-owned tables); every row here is written by
-- our own service inside the order's transaction, so integrity is free.
-- The exception is `events.created_by`: it points at `bo_users`, which this
-- schema does not own.

CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "cover_url" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "location" TEXT,
    "location_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "events_slug_key" ON "events"("slug");
CREATE INDEX "events_status_starts_at_idx" ON "events"("status", "starts_at");

-- One row per sellable ticket kind, 1:1 with a `products` row of
-- type='event_ticket'. Price is read from that product and never copied here.
CREATE TABLE "event_ticket_types" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quota" INTEGER,
    "max_per_order" INTEGER NOT NULL DEFAULT 10,
    "sale_starts_at" TIMESTAMP(3),
    "sale_ends_at" TIMESTAMP(3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_ticket_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_ticket_types_product_id_key" ON "event_ticket_types"("product_id");
CREATE INDEX "event_ticket_types_event_id_idx" ON "event_ticket_types"("event_id");

-- One seat, one attendee, one code. N rows per order.
--
-- `status` is load-bearing, not decoration: the quota query counts
-- RESERVED + ISSUED per ticket type, which is what
-- `event_tickets_ticket_type_id_status_idx` exists to serve. Seats come back
-- only when `expirePendingTransactions` releases them.
CREATE TABLE "event_tickets" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "ticket_type_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "buyer_member_id" UUID NOT NULL,
    "attendee_name" TEXT NOT NULL,
    "attendee_email" TEXT NOT NULL,
    "member_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "issued_at" TIMESTAMP(3),
    "email_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_tickets_code_key" ON "event_tickets"("code");
CREATE INDEX "event_tickets_transaction_id_idx" ON "event_tickets"("transaction_id");
-- The same email may hold several tickets (P5) — indexed, never unique.
CREATE INDEX "event_tickets_attendee_email_idx" ON "event_tickets"("attendee_email");
CREATE INDEX "event_tickets_ticket_type_id_status_idx" ON "event_tickets"("ticket_type_id", "status");

ALTER TABLE "event_ticket_types" ADD CONSTRAINT "event_ticket_types_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_ticket_types" ADD CONSTRAINT "event_ticket_types_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "event_ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "commerce_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_buyer_member_id_fkey" FOREIGN KEY ("buyer_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
