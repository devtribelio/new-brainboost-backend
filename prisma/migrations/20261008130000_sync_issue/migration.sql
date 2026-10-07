-- Reconciliation list for the resync (audit 07 #13): a legacy row the syncer could not process
-- (unresolved parent/member, guard-blocked, missing master data). Only "needs attention"
-- reasons are written; out-of-scope skips are counted in sync_state.last_stats.skipReasons.
-- A SKIPPED row still advances the watermark (by design), so this table is the only trace left.
CREATE TABLE "sync_issue" (
    "id" UUID NOT NULL,
    "syncer" TEXT NOT NULL,
    "legacy_pk" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "sync_issue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sync_issue_syncer_legacy_pk_reason_key" ON "sync_issue"("syncer", "legacy_pk", "reason");
CREATE INDEX "sync_issue_syncer_reason_idx" ON "sync_issue"("syncer", "reason");
