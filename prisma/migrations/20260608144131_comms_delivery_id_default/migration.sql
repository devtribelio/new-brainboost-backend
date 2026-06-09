-- comms_delivery is written by bb-comms via Kysely (no Prisma client-side
-- uuid). Give the id a DB-level default so inserts need not supply it.
ALTER TABLE "comms_delivery" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
