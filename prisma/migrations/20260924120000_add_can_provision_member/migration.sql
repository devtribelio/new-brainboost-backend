-- Per-credential toggle: may the channel auto-create a Brainboost Member when the
-- buyer has no account yet (Scalev ingest, M1)?
--
-- SAFE DEFAULT off: this is the access-granting path, so provisioning stays gated
-- behind an explicit opt-in per credential (mirrors triggers_affiliate /
-- can_ingest_refund). Existing rows keep the default false and are unaffected.
ALTER TABLE "third_party_credentials" ADD COLUMN "can_provision_member" BOOLEAN NOT NULL DEFAULT false;
