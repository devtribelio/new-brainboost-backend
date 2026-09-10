-- Phone the buyer typed at checkout, kept on the ORDER.
--
-- `members.phone` cannot hold it reliably: it is UNIQUE, it must never be
-- overwritten from an unauthenticated form, and it is skipped entirely whenever
-- the email already has an account — which is every repeat purchase. The number
-- an organiser needs is "who paid for THIS order", which is a property of the
-- order, so that is where it lives. No unique, no identity semantics.
ALTER TABLE "commerce_transactions" ADD COLUMN "buyer_phone" TEXT;
