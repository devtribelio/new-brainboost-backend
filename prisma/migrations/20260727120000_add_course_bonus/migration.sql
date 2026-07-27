-- Bonus attachments (PDF workbooks etc.) for a course. NEW feature — no legacy
-- counterpart (no legacy_id). Files live under the S3 `private/` prefix; `file_key`
-- is server-only. Ingestion is done by backoffice-bb (raw SQL INSERT + S3 write);
-- this backend owns the read/gate side. NOTE: `id` has no DB default (Prisma mints
-- uuid v7 client-side) and `updated_at` has no DB default (@updatedAt) — a raw-SQL
-- writer must supply both.
CREATE TABLE "course_bonuses" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
    "downloadable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_bonuses_pkey" PRIMARY KEY ("id")
);

-- Course detail loads a single course's bonuses ordered by sort_order.
CREATE INDEX "course_bonuses_course_id_sort_order_idx" ON "course_bonuses"("course_id", "sort_order");

ALTER TABLE "course_bonuses" ADD CONSTRAINT "course_bonuses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
