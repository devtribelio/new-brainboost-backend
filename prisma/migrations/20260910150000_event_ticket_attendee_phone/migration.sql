-- Optional phone for an attendee, so the organiser can reach the person who is
-- actually attending rather than only whoever paid.
--
-- Not an identity: no unique, no verification, never matched against
-- members.phone. Stored in full E.164 (+6281…), unlike members.phone and
-- commerce_transactions.buyer_phone, which keep the national part and the dial
-- code in separate columns — those two are read through one COALESCE and the
-- national form is what the unique index and login-by-phone match on. This column
-- has neither partner nor lookup, so the dialable form is the useful one.
ALTER TABLE "event_tickets" ADD COLUMN "attendee_phone" TEXT;
