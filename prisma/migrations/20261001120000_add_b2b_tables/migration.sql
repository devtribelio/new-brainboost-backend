-- B2B tables + members.signup_source + course_enrollment.via_b2b_grant_id.
--
-- The B2B backend (repo `brainboost-b2b-be`) is moving off its own Supabase
-- Postgres onto THIS database so that member / product / course / access data
-- stops living in two places. Everything prefixed `b2b_` is that app's data:
-- it introspects this schema with `prisma db pull`, and only this repo runs
-- migrations. This app never writes `b2b_*`.
--
-- Column names are snake_case exactly as the B2B code already queries them.
-- Every `id` has a DB default (gen_random_uuid) and `updated_at` a DB default
-- (no @updatedAt) because the B2B app is a separate Prisma client that inserts
-- without minting ids and maintains updated_at itself.
--
-- Shared-table contract (mirrors the schema comment on the B2B block; PRD lives
-- in brainboost-b2b-be/.claude/prds/b2b-db-consolidation.prd.md):
--  - `members.signup_source`: B2B writes 'b2b' ONCE when it creates a Member for
--    an employee with no account. Birth fact, never a status, never a gate.
--    Nullable, no backfill here; other signup paths may stamp it later.
--  - `members`: B2B never updates / deactivates / deletes a row after creation.
--  - `course_enrollment`: gains ONE nullable column `via_b2b_grant_id` (no FK,
--    same pattern as via_voucher_id) = the B2B grant that gave this row. B2B may
--    only modify rows whose marker is filled; paid rows (marker null, expired_date
--    null) are never touched. The payment-success listener clears the marker when
--    the member buys the course themselves; the legacy resync enrollments syncer
--    must skip marked rows. Unique (member_id, course_id) unchanged.
--  - `b2b_member_grant` -> members/courses is ON DELETE RESTRICT on purpose: a
--    member or course with live B2B grants must not silently disappear.
--
-- Tables are created empty. The one-shot data copy from the old Supabase DB is a
-- separate step owned by the B2B repo (its PRD milestone 5).

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "signup_source" TEXT;

-- AlterTable
ALTER TABLE "course_enrollment" ADD COLUMN     "via_b2b_grant_id" UUID;

-- CreateTable
CREATE TABLE "b2b_industry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_industry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_name" VARCHAR,
    "company_business_name" VARCHAR,
    "address" VARCHAR,
    "city" VARCHAR,
    "owner_name" VARCHAR,
    "owner_email" VARCHAR,
    "owner_phone_number" VARCHAR,
    "industry_id" UUID,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_team_customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID,
    "name" TEXT,
    "email" TEXT,
    "phone_number" TEXT,
    "address" TEXT,
    "role" TEXT,
    "is_active" BOOLEAN,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_team_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_management" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone_number" VARCHAR,
    "address" VARCHAR,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_management_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR,
    "email" VARCHAR,
    "phone" VARCHAR,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID,
    "management_id" UUID,
    "team_customer" UUID,
    "name" VARCHAR,
    "email" VARCHAR,
    "password" VARCHAR,
    "role" VARCHAR,
    "type" VARCHAR,
    "is_active" BOOLEAN DEFAULT true,
    "refresh_token" VARCHAR,
    "password_changed_at" TIMESTAMP(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_user_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" VARCHAR(45),
    "last_active" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_password_reset_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "token" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "is_used" BOOLEAN,
    "invalidated_at" TIMESTAMPTZ(6),
    "last_request_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_module" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_module_product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "module_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_module_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_payment_plan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "package" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_payment_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_payment_plan_module" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_plan_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_payment_plan_module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_invoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_number" VARCHAR(255) NOT NULL,
    "customer_id" UUID NOT NULL,
    "payment_plan_id" UUID NOT NULL,
    "payment_plan" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'IDR',
    "status" VARCHAR(20) NOT NULL DEFAULT 'paid',
    "duration" VARCHAR(50),
    "start_date" TIMESTAMP(6),
    "end_date" TIMESTAMP(6),
    "quota" INTEGER NOT NULL DEFAULT 0,
    "used_quota" INTEGER NOT NULL DEFAULT 0,
    "payment_method" VARCHAR(255),
    "bank" VARCHAR(255),
    "account_holder_name" VARCHAR(255),
    "account_number" VARCHAR(255),
    "issued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_subscription_notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "payment_plan_id" UUID,
    "notification_type" VARCHAR(20) NOT NULL,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_subscription_notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_member_import_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "file_url" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_member_import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_member_copy_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "source_plan_id" UUID NOT NULL,
    "target_plan_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_member_copy_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2b_member_grant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "payment_plan_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "granted_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "b2b_member_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "b2b_customer_industry_id_idx" ON "b2b_customer"("industry_id");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_team_customer_email_key" ON "b2b_team_customer"("email");

-- CreateIndex
CREATE INDEX "b2b_team_customer_customer_id_idx" ON "b2b_team_customer"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_user_email_idx" ON "b2b_user"("email");

-- CreateIndex
CREATE INDEX "b2b_user_customer_id_idx" ON "b2b_user"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_user_management_id_idx" ON "b2b_user"("management_id");

-- CreateIndex
CREATE INDEX "b2b_user_team_customer_idx" ON "b2b_user"("team_customer");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_user_session_refresh_token_key" ON "b2b_user_session"("refresh_token");

-- CreateIndex
CREATE INDEX "b2b_user_session_user_id_idx" ON "b2b_user_session"("user_id");

-- CreateIndex
CREATE INDEX "b2b_password_reset_token_user_id_idx" ON "b2b_password_reset_token"("user_id");

-- CreateIndex
CREATE INDEX "b2b_password_reset_token_token_idx" ON "b2b_password_reset_token"("token");

-- CreateIndex
CREATE INDEX "b2b_module_name_idx" ON "b2b_module"("name");

-- CreateIndex
CREATE INDEX "b2b_module_product_product_id_idx" ON "b2b_module_product"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_module_product_module_id_product_id_key" ON "b2b_module_product"("module_id", "product_id");

-- CreateIndex
CREATE INDEX "b2b_payment_plan_customer_id_idx" ON "b2b_payment_plan"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_payment_plan_is_active_idx" ON "b2b_payment_plan"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_payment_plan_module_payment_plan_id_module_id_key" ON "b2b_payment_plan_module"("payment_plan_id", "module_id");

-- CreateIndex
CREATE INDEX "b2b_invoice_payment_plan_id_idx" ON "b2b_invoice"("payment_plan_id");

-- CreateIndex
CREATE INDEX "b2b_invoice_customer_id_idx" ON "b2b_invoice"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_invoice_payment_plan_id_status_end_date_idx" ON "b2b_invoice"("payment_plan_id", "status", "end_date" DESC);

-- CreateIndex
CREATE INDEX "b2b_subscription_notification_customer_id_idx" ON "b2b_subscription_notification"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_subscription_notification_payment_plan_id_idx" ON "b2b_subscription_notification"("payment_plan_id");

-- CreateIndex
CREATE INDEX "b2b_subscription_notification_customer_id_payment_plan_id_n_idx" ON "b2b_subscription_notification"("customer_id", "payment_plan_id", "notification_type", "sent_at");

-- CreateIndex
CREATE INDEX "b2b_subscription_notification_customer_id_notification_type_idx" ON "b2b_subscription_notification"("customer_id", "notification_type", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_member_import_job_job_id_key" ON "b2b_member_import_job"("job_id");

-- CreateIndex
CREATE INDEX "b2b_member_import_job_customer_id_idx" ON "b2b_member_import_job"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_member_import_job_status_idx" ON "b2b_member_import_job"("status");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_member_copy_job_job_id_key" ON "b2b_member_copy_job"("job_id");

-- CreateIndex
CREATE INDEX "b2b_member_copy_job_customer_id_idx" ON "b2b_member_copy_job"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_member_copy_job_status_idx" ON "b2b_member_copy_job"("status");

-- CreateIndex
CREATE INDEX "b2b_member_grant_member_id_course_id_idx" ON "b2b_member_grant"("member_id", "course_id");

-- CreateIndex
CREATE INDEX "b2b_member_grant_customer_id_idx" ON "b2b_member_grant"("customer_id");

-- CreateIndex
CREATE INDEX "b2b_member_grant_payment_plan_id_is_active_idx" ON "b2b_member_grant"("payment_plan_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "b2b_member_grant_payment_plan_id_member_id_course_id_key" ON "b2b_member_grant"("payment_plan_id", "member_id", "course_id");

-- CreateIndex
CREATE INDEX "course_enrollment_via_b2b_grant_id_idx" ON "course_enrollment"("via_b2b_grant_id");

-- AddForeignKey
ALTER TABLE "b2b_customer" ADD CONSTRAINT "b2b_customer_industry_id_fkey" FOREIGN KEY ("industry_id") REFERENCES "b2b_industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_team_customer" ADD CONSTRAINT "b2b_team_customer_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_user" ADD CONSTRAINT "b2b_user_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_user" ADD CONSTRAINT "b2b_user_management_id_fkey" FOREIGN KEY ("management_id") REFERENCES "b2b_management"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_user" ADD CONSTRAINT "b2b_user_team_customer_fkey" FOREIGN KEY ("team_customer") REFERENCES "b2b_team_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_user_session" ADD CONSTRAINT "b2b_user_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "b2b_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_password_reset_token" ADD CONSTRAINT "b2b_password_reset_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "b2b_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_module_product" ADD CONSTRAINT "b2b_module_product_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "b2b_module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_module_product" ADD CONSTRAINT "b2b_module_product_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_payment_plan" ADD CONSTRAINT "b2b_payment_plan_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_payment_plan_module" ADD CONSTRAINT "b2b_payment_plan_module_payment_plan_id_fkey" FOREIGN KEY ("payment_plan_id") REFERENCES "b2b_payment_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_payment_plan_module" ADD CONSTRAINT "b2b_payment_plan_module_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "b2b_module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_invoice" ADD CONSTRAINT "b2b_invoice_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_invoice" ADD CONSTRAINT "b2b_invoice_payment_plan_id_fkey" FOREIGN KEY ("payment_plan_id") REFERENCES "b2b_payment_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_invoice" ADD CONSTRAINT "b2b_invoice_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "b2b_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_invoice" ADD CONSTRAINT "b2b_invoice_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "b2b_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_subscription_notification" ADD CONSTRAINT "b2b_subscription_notification_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_subscription_notification" ADD CONSTRAINT "b2b_subscription_notification_payment_plan_id_fkey" FOREIGN KEY ("payment_plan_id") REFERENCES "b2b_payment_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_member_grant" ADD CONSTRAINT "b2b_member_grant_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "b2b_customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_member_grant" ADD CONSTRAINT "b2b_member_grant_payment_plan_id_fkey" FOREIGN KEY ("payment_plan_id") REFERENCES "b2b_payment_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_member_grant" ADD CONSTRAINT "b2b_member_grant_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_member_grant" ADD CONSTRAINT "b2b_member_grant_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_member_grant" ADD CONSTRAINT "b2b_member_grant_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "b2b_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

