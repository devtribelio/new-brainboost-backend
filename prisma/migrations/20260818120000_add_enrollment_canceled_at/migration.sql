-- Refund revokes course access by soft-cancelling the enrollment (is_canceled),
-- which preserves progress/purchase history the old hard DELETE destroyed.
-- `updated_at` cannot serve as the cancellation timestamp: it is overwritten by
-- every progress write, so the moment of revocation would be lost.
ALTER TABLE "course_enrollment" ADD COLUMN "canceled_at" TIMESTAMP(3);
