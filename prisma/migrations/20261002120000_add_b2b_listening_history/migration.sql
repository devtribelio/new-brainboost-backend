-- B2B listening history archive (read-only).
--
-- Keeps the B2B dashboard history from the old Supabase `analytics_events`
-- (Firebase/BigQuery events synced daily by the retired b2b-workers data-sync).
-- The B2B repo copies it ONCE during its one-shot data migration; nothing writes
-- here afterwards. Only events before each member's first `listening_session`
-- are copied, so dashboards UNION ALL this table with `listening_session`
-- without double counting. `listening_session` (mobile-owned) is NOT touched,
-- so streaks / challenges / recaps in the app do not change.
--
-- Additive only: one new empty table, no change to existing tables.

-- CreateTable
CREATE TABLE "b2b_listening_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "member_id" UUID,
    "course_id" UUID,
    "source_event_key" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "listened_sec" INTEGER NOT NULL DEFAULT 0,
    "legacy_member_id" INTEGER,
    "email" TEXT,
    "product_code" TEXT,
    "product_name" TEXT,
    "device_id" TEXT,
    "operating_system" TEXT,
    "operating_system_version" TEXT,
    "mobile_brand_name" TEXT,
    "mobile_model_name" TEXT,
    "mobile_marketing_name" TEXT,
    "city" TEXT,
    "country" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_listening_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "b2b_listening_history_source_event_key_key" ON "b2b_listening_history"("source_event_key");

-- CreateIndex
CREATE INDEX "b2b_listening_history_customer_id_occurred_at_idx" ON "b2b_listening_history"("customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "b2b_listening_history_member_id_occurred_at_idx" ON "b2b_listening_history"("member_id", "occurred_at");

-- CreateIndex
CREATE INDEX "b2b_listening_history_course_id_idx" ON "b2b_listening_history"("course_id");

-- AddForeignKey
ALTER TABLE "b2b_listening_history" ADD CONSTRAINT "b2b_listening_history_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_listening_history" ADD CONSTRAINT "b2b_listening_history_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_listening_history" ADD CONSTRAINT "b2b_listening_history_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

