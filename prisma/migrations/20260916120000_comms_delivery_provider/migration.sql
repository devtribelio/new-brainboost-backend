-- Which WhatsApp provider delivered a message.
--
-- Additive and nullable: every existing row keeps NULL, which is exactly what it
-- means — those sends predate the provider registry, and for email there has only
-- ever been one sender.
--
-- Written by bb-comms (Kysely/pgx, not Prisma), read by the backoffice report that
-- compares providers over the last 24 hours.
ALTER TABLE "comms_delivery" ADD COLUMN "provider" TEXT;

-- The report groups by provider over a recent window; without this it scans the
-- whole delivery log every page load.
CREATE INDEX "comms_delivery_provider_created_at_idx"
  ON "comms_delivery" ("provider", "created_at");
