-- B2B app support.
--
-- 1. devices.app: 'brainboost' (default, every installed build) | 'b2b' (company
--    app). Push delivery and the single-active-push-device rule become per app,
--    so installing the B2B app never silences the regular app and consumer
--    notifications never reach the B2B app. Existing rows get the default.
-- 2. b2b_company_branding: per-company theme of the B2B app, written by the B2B
--    portal, read by mobile-api /api/b2b-app/*.
--
-- Additive only: a NOT NULL column with a constant default (no table rewrite on
-- PG 11+), one index, one new empty table.

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "app" TEXT NOT NULL DEFAULT 'brainboost';

-- CreateTable
CREATE TABLE "b2b_company_branding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "display_name" VARCHAR(120),
    "logo_url" TEXT,
    "primary_color" VARCHAR(7),
    "welcome_text" VARCHAR(500),
    "course_layout" JSONB,
    "announcements" JSONB,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_company_branding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "b2b_company_branding_customer_id_key" ON "b2b_company_branding"("customer_id");

-- CreateIndex
CREATE INDEX "devices_member_id_app_idx" ON "devices"("member_id", "app");

-- AddForeignKey
ALTER TABLE "b2b_company_branding" ADD CONSTRAINT "b2b_company_branding_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

