-- Subscription Phase 1 (annual) — BE-01. See docs/prd-subscription-backend.md.
-- Hand-written via `prisma migrate diff` (migrate dev unusable non-interactively and
-- must not touch the pre-existing bo_* drift on the dev DB). Three partial unique
-- indexes at the bottom are manual SQL — Prisma cannot express them.

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELED');

-- AlterTable
ALTER TABLE "course_enrollment" ADD COLUMN     "via_subscription_id" UUID;

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "period_months" INTEGER NOT NULL,
    "seat_count" INTEGER NOT NULL,
    "affiliate_rate" INTEGER NOT NULL,
    "renewal_affiliate_rate" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_subscriptions" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "grace_until" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "provider_ref" TEXT,
    "latest_transaction_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_seats" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "seat_no" INTEGER NOT NULL,
    "member_id" UUID,
    "invite_code" TEXT,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_activations" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "transaction_id" UUID,
    "provider_ref" TEXT,
    "previous_expires_at" TIMESTAMP(3),
    "new_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_reminder_logs" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "days_before" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_reminder_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_product_id_key" ON "subscription_plans"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE INDEX "member_subscriptions_owner_id_idx" ON "member_subscriptions"("owner_id");

-- CreateIndex
CREATE INDEX "member_subscriptions_provider_ref_idx" ON "member_subscriptions"("provider_ref");

-- CreateIndex
CREATE INDEX "member_subscriptions_status_expires_at_idx" ON "member_subscriptions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_seats_invite_code_key" ON "subscription_seats"("invite_code");

-- CreateIndex
CREATE INDEX "subscription_seats_member_id_idx" ON "subscription_seats"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_seats_subscription_id_seat_no_key" ON "subscription_seats"("subscription_id", "seat_no");

-- CreateIndex
CREATE INDEX "subscription_activations_subscription_id_created_at_idx" ON "subscription_activations"("subscription_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_reminder_logs_subscription_id_expires_at_days__key" ON "subscription_reminder_logs"("subscription_id", "expires_at", "days_before");

-- CreateIndex
CREATE INDEX "course_enrollment_via_subscription_id_idx" ON "course_enrollment"("via_subscription_id");

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_seats" ADD CONSTRAINT "subscription_seats_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "member_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_seats" ADD CONSTRAINT "subscription_seats_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_activations" ADD CONSTRAINT "subscription_activations_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "member_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_reminder_logs" ADD CONSTRAINT "subscription_reminder_logs_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "member_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Partial unique indexes (manual SQL — not expressible in Prisma schema).
-- Prisma's diff engine ignores partial indexes, so these do not create drift.
-- ============================================================================

-- At most ONE ACTIVE subscription per owner (DB-level guard, not just app logic).
CREATE UNIQUE INDEX "uniq_active_sub_per_owner" ON "member_subscriptions" ("owner_id") WHERE "status" = 'ACTIVE';

-- A member can hold at most ONE seat across all subscriptions; concurrent
-- double-claims lose at the DB (P2002), empty slots (NULL) unconstrained.
CREATE UNIQUE INDEX "uniq_active_seat_per_member" ON "subscription_seats" ("member_id") WHERE "member_id" IS NOT NULL;

-- Idempotency ledger: one activation per commerce transaction; webhook redelivery
-- hits P2002 → no-op. NULL exempt (grants have no transaction).
CREATE UNIQUE INDEX "uniq_activation_tx" ON "subscription_activations" ("transaction_id") WHERE "transaction_id" IS NOT NULL;
