-- Free-trial voucher: `vouchers.type = 'TRIAL'` grants time-boxed course access
-- instead of a discount. The order still settles through the existing amount=0
-- voucher-bypass path, so no payment code changes.
--
-- `voucher_redemptions` is deliberately UNTOUCHED: quota + per-order idempotency
-- keep working exactly as before, and the record of "this member already used this
-- trial" is the enrollment row's `via_voucher_id` — which already carries member_id.

-- 1. Duration of the granted access. NULL for PERCENT/AMOUNT. The CHECK is the
--    only thing standing between a typo in the backoffice and a trial that grants
--    zero (or negative) days of access, i.e. a paid-looking order with no content.
ALTER TABLE "vouchers" ADD COLUMN "trial_days" INTEGER;
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_trial_days_check"
  CHECK ("type" <> 'TRIAL' OR ("trial_days" IS NOT NULL AND "trial_days" > 0));

-- 2. Trial-granted enrollments. NULL = retail/legacy → access gates ignore
--    expired_date (legacy migration filled it on lifetime purchases). No FK:
--    deleting a voucher must not delete the enrollment it granted. Doubles as the
--    once-per-member record: the row survives expiry, so a member cannot re-trial
--    the same course with the same code.
ALTER TABLE "course_enrollment" ADD COLUMN "via_voucher_id" UUID;
CREATE INDEX "course_enrollment_via_voucher_id_idx" ON "course_enrollment" ("via_voucher_id");
