-- Move the ticket-email overrides from the event to the ticket kind.
--
-- Per event was wrong for the case that actually motivated the feature: an
-- Online attendee needs the Zoom link and an Offline attendee needs the venue
-- and the gate time. One call-to-action per event sends one of those two groups
-- somewhere useless.
--
-- Nothing is preserved on the way across. The previous columns shipped nowhere —
-- migration 20260909140000 has never been applied outside a developer machine —
-- so there is no operator copy to carry over, and inventing a fan-out (which
-- ticket kind would inherit it?) would be guesswork.
ALTER TABLE "events" DROP COLUMN "email_subject";
ALTER TABLE "events" DROP COLUMN "email_body";
ALTER TABLE "events" DROP COLUMN "email_footer";
ALTER TABLE "events" DROP COLUMN "email_cta_label";
ALTER TABLE "events" DROP COLUMN "email_cta_url";

ALTER TABLE "event_ticket_types" ADD COLUMN "email_subject" TEXT;
ALTER TABLE "event_ticket_types" ADD COLUMN "email_body" TEXT;
ALTER TABLE "event_ticket_types" ADD COLUMN "email_footer" TEXT;
ALTER TABLE "event_ticket_types" ADD COLUMN "email_cta_label" TEXT;
ALTER TABLE "event_ticket_types" ADD COLUMN "email_cta_url" TEXT;
