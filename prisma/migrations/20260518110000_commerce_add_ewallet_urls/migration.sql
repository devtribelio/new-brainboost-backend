-- Surface eWallet AUTH URLs on poll endpoint. Mobile previously had to
-- cache URLs from the create response; persisting lets the poll endpoint
-- recover them after app restart / cold launch.

ALTER TABLE "commerce_payments"
  ADD COLUMN "checkoutUrl" TEXT,
  ADD COLUMN "deeplinkUrl" TEXT;
