-- Upgrade proration: the unused part of the running subscription term, credited
-- against the new plan's price. Behaves like a voucher on the way to `amount`.
ALTER TABLE "commerce_transactions"
  ADD COLUMN "proration_credit" INTEGER NOT NULL DEFAULT 0;
