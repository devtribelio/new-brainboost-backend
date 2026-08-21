-- Scheduled tier change (Approach B). A downgrade is DECLARED now and APPLIED
-- by the renewal that bills the new plan; an upgrade is charged immediately and
-- keeps applying on the spot, so it never lands here.
ALTER TABLE "member_subscriptions"
  ADD COLUMN "pending_plan_id" UUID,
  ADD COLUMN "pending_effective_at" TIMESTAMP(3),
  ADD COLUMN "pending_source" TEXT,
  ADD COLUMN "pending_declared_at" TIMESTAMP(3);

-- Owner's eviction choice lives on the seat, not on the subscription: a member
-- who leaves before the change lands drops out of the selection with no cleanup.
ALTER TABLE "subscription_seats"
  ADD COLUMN "pending_keep" BOOLEAN NOT NULL DEFAULT false;

-- Drives the "prompt the owner to choose" reminder job; tiny partial index
-- because only a handful of rows ever carry a pending change.
CREATE INDEX "member_subscriptions_pending_effective_at_idx"
  ON "member_subscriptions" ("pending_effective_at")
  WHERE "pending_plan_id" IS NOT NULL;
