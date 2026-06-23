-- AlterTable: listening-challenge duration in days (90/60/30). Defaults to 30
-- (the "30-Day Challenge" card), backfilling all existing courses.
ALTER TABLE "courses" ADD COLUMN "program_days" INTEGER NOT NULL DEFAULT 30;
