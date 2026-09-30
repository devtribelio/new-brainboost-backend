-- PPN frozen on each order at creation. Default 0 = no tax: every existing row
-- and every new order while `app_settings.tax.rate` is unset keep today's numbers.
ALTER TABLE "commerce_transactions"
  ADD COLUMN "tax_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "tax_amount" INTEGER NOT NULL DEFAULT 0;
