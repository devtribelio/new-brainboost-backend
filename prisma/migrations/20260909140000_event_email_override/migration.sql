-- Per-event overrides for the ticket email. All optional, all plain text, each
-- falling back on its own to the standard copy.
--
-- Text and not HTML: bb-comms renders with html/template, which escapes by
-- default, so accepting HTML would mean explicitly marking operator input safe.
-- Blank lines in the body become paragraphs at render time.
--
-- Scoped to the ticket email an attendee receives, not the payer's summary: a
-- receipt should be predictable, and free copy above a table of amounts invites
-- a sentence that contradicts the numbers below it.
ALTER TABLE "events" ADD COLUMN "email_subject" TEXT;
ALTER TABLE "events" ADD COLUMN "email_body" TEXT;
ALTER TABLE "events" ADD COLUMN "email_footer" TEXT;
ALTER TABLE "events" ADD COLUMN "email_cta_label" TEXT;
ALTER TABLE "events" ADD COLUMN "email_cta_url" TEXT;
