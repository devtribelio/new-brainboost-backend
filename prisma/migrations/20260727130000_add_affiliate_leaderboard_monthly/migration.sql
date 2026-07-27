-- Pre-aggregated monthly affiliate leaderboard (§11 / BB-121). Derived, read-only
-- table recomputed by a scheduled job (SUM(amount) per recipient per WIB month,
-- status != VOIDED, ranked). NEW feature — no legacy counterpart (no legacy_id).
-- `id` has no DB default (Prisma mints uuid v7 client-side) and `updated_at` has
-- no DB default (@updatedAt).
CREATE TABLE "affiliate_leaderboard_monthly" (
    "id" UUID NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "member_id" UUID NOT NULL,
    "total_commission" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_leaderboard_monthly_pkey" PRIMARY KEY ("id")
);

-- One row per member per period.
CREATE UNIQUE INDEX "alm_period_member_key" ON "affiliate_leaderboard_monthly"("period_year", "period_month", "member_id");

-- Read top-N ordered by rank for a period.
CREATE INDEX "alm_period_rank_idx" ON "affiliate_leaderboard_monthly"("period_year", "period_month", "rank");

ALTER TABLE "affiliate_leaderboard_monthly" ADD CONSTRAINT "affiliate_leaderboard_monthly_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
