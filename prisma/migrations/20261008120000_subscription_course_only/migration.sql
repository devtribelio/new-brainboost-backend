-- Subscription all-access now covers products.type = 'course' only (2026-10-08).
-- A lazy row (via_subscription_id set) a subscriber opened on any other type —
-- in practice mini_course — stops passing the access gate NOW instead of at the
-- subscription's expiry. Expiring rather than deleting keeps `progress`, and
-- the renewal bump no longer touches uncovered rows, so it cannot come back.
-- Retail rows (via_subscription_id NULL) are untouched. Idempotent.
UPDATE course_enrollment ce
SET expired_date = now()
FROM courses c
JOIN products p ON p.id = c.product_id
WHERE ce.course_id = c.id
  AND ce.via_subscription_id IS NOT NULL
  AND p.type <> 'course'
  AND (ce.expired_date IS NULL OR ce.expired_date > now());
