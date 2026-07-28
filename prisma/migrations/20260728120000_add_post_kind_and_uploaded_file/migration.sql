-- §4 / BB-116 — two additions:
--   1. post_kinds: BE-sourced post taxonomy + posts.kind_id
--   2. uploaded_files: registry of S3 uploads so orphans can be swept
-- NOTE: `id` has no DB default (Prisma mints uuid v7 client-side) and `updated_at`
-- has no DB default (@updatedAt) — any direct writer must supply both.

-- ── 1. Post kind taxonomy ────────────────────────────────────────────────────
CREATE TABLE "post_kinds" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_kinds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "post_kinds_slug_key" ON "post_kinds"("slug");
CREATE INDEX "post_kinds_is_active_sort_order_idx" ON "post_kinds"("is_active", "sort_order");

-- Launch taxonomy. Fixed UUIDs (v7-shaped) so ids match across dev/test/prod —
-- FE caches the list client-side and must not see ids shift per environment.
-- Exactly one row is is_default (Diskusi): applied when a client omits kindId.
INSERT INTO "post_kinds" ("id", "name", "slug", "sort_order", "is_default", "is_active", "updated_at") VALUES
  ('01991a00-0000-7000-8000-000000000001', 'Testimoni', 'testimoni', 0, false, true, CURRENT_TIMESTAMP),
  ('01991a00-0000-7000-8000-000000000002', 'Tips',      'tips',      1, false, true, CURRENT_TIMESTAMP),
  ('01991a00-0000-7000-8000-000000000003', 'Diskusi',   'diskusi',   2, true,  true, CURRENT_TIMESTAMP),
  ('01991a00-0000-7000-8000-000000000004', 'Progress',  'progress',  3, false, true, CURRENT_TIMESTAMP),
  ('01991a00-0000-7000-8000-000000000005', 'Tanya',     'tanya',     4, false, true, CURRENT_TIMESTAMP);

-- Only one default kind may exist — enforced in the DB, not just in code.
-- (Partial index: Prisma's schema language can't model it, so it lives only here.)
CREATE UNIQUE INDEX "post_kinds_single_default_idx" ON "post_kinds"("is_default") WHERE "is_default";

ALTER TABLE "posts" ADD COLUMN "kind_id" UUID;
CREATE INDEX "posts_kind_id_idx" ON "posts"("kind_id");
ALTER TABLE "posts" ADD CONSTRAINT "posts_kind_id_fkey" FOREIGN KEY ("kind_id") REFERENCES "post_kinds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. Uploaded-file registry ────────────────────────────────────────────────
-- No FK on owner_id by design (see schema.prisma comment): an upload must never
-- fail on a FK, and a member delete must not strand S3 objects unsweepable.
CREATE TABLE "uploaded_files" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "public_url" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "referenced_at" TIMESTAMP(3),
    "reference_type" TEXT,
    "reference_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uploaded_files_key_key" ON "uploaded_files"("key");
CREATE INDEX "uploaded_files_referenced_at_created_at_idx" ON "uploaded_files"("referenced_at", "created_at");
CREATE INDEX "uploaded_files_owner_id_created_at_idx" ON "uploaded_files"("owner_id", "created_at");
