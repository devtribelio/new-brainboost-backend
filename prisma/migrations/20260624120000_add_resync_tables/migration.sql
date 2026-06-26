-- Legacy resync (transition-period incremental sync). See docs/legacy-resync-plan.md.
-- Additive only: a nullable column on members + two new tables. Hand-written and applied
-- with `prisma migrate deploy` (NEVER `migrate dev` on a populated DB — bo_* drift).

-- new-wins-on-touch marker (null = never resynced / legacy-owned)
ALTER TABLE "members" ADD COLUMN "legacy_synced_at" TIMESTAMP(3);

-- per-syncer watermark + stats
CREATE TABLE "sync_state" (
    "syncer" TEXT NOT NULL,
    "watermark" TEXT,
    "last_run_at" TIMESTAMP(3),
    "last_stats" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("syncer")
);

-- durable dedup map (replaces scripts/member-redirect.json)
CREATE TABLE "member_redirect" (
    "loser_legacy_id" INTEGER NOT NULL,
    "winner_legacy_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_redirect_pkey" PRIMARY KEY ("loser_legacy_id")
);

CREATE INDEX "member_redirect_winner_legacy_id_idx" ON "member_redirect"("winner_legacy_id");
