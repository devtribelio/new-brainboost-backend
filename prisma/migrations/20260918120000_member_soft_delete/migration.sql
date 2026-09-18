-- Soft delete for member accounts.
--
-- `scheduled_deletion_at` (already present) = the DEADLINE. `deleted_at` = the RECEIPT:
-- the moment the purge job anonymised the row. The members row is NEVER deleted --
-- every FK, the affiliate inviter chain and the entire financial history hang off it.
--
-- No unique constraint changes: the purge rewrites unique columns to a per-row
-- distinct value (`del:<uuid>:<mask>`), which frees the original email / phone /
-- username for someone else to register with.
ALTER TABLE "members" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- The purge job's only scan: rows past their deadline that were never executed.
-- Partial so it stays tiny (almost every row has scheduled_deletion_at NULL).
CREATE INDEX "members_scheduled_deletion_at_pending_idx"
  ON "members" ("scheduled_deletion_at")
  WHERE "deleted_at" IS NULL AND "scheduled_deletion_at" IS NOT NULL;
