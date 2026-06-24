-- Append-only audit trail for KYC status transitions (AML). The current state
-- still lives on members.kyc*; this records the history, including re-KYC RESETs
-- (bank change / dormant reactivation / large disbursement / suspicious).
-- See docs/kyc-rekyc.md. No DDL on members: kycStatus is a free-form string so
-- the new EXPIRED value needs no column change, and last_active_at already exists.
CREATE TABLE "kyc_event" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kyc_event_member_id_created_at_idx" ON "kyc_event"("member_id", "created_at");

ALTER TABLE "kyc_event" ADD CONSTRAINT "kyc_event_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
