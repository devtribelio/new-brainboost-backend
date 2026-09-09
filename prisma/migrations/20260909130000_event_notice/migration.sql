-- Announcement strip for an event: plain text, an optional link label, and an
-- optional target. Purely additive, all nullable.
--
-- Three text columns rather than one HTML column: with HTML the operator writes
-- the anchor, and a `javascript:` href is then one paste away from a public
-- page. Plain text cannot become markup.
--
-- `notice_link_url` NULL means "the event's own page". It is resolved when read,
-- never written: the slug stays editable until a ticket sells, so a stored
-- absolute URL would silently rot into a 404.
ALTER TABLE "events" ADD COLUMN "notice_text" TEXT;
ALTER TABLE "events" ADD COLUMN "notice_link_label" TEXT;
ALTER TABLE "events" ADD COLUMN "notice_link_url" TEXT;
