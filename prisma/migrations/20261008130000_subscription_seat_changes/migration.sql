-- Seat-resale deterrent (2026-10-08): cap guest-seat vacates per term.
ALTER TABLE "subscription_plans" ADD COLUMN "max_seat_changes" INTEGER;
ALTER TABLE "member_subscriptions" ADD COLUMN "seat_changes" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "subscription_seat_events" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "seat_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "member_id" UUID,
    "actor_id" UUID,
    "seat_changes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscription_seat_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "subscription_seat_events_subscription_id_created_at_idx"
    ON "subscription_seat_events"("subscription_id", "created_at");
ALTER TABLE "subscription_seat_events"
    ADD CONSTRAINT "subscription_seat_events_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "member_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
