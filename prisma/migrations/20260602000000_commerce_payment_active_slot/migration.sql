-- Conditional-unique guard against concurrent checkout creating >1 active payment per transaction.
-- `active_slot_tx_id` holds the transaction_id while the payment is active (PENDING or SUCCESS);
-- it is NULLed once the payment is EXPIRED/FAILED/CANCELED so a retry can reclaim the slot.
-- NULLs are distinct in a unique index (Postgres standard conditional-uniqueness pattern).
ALTER TABLE "commerce_payments" ADD COLUMN "active_slot_tx_id" UUID;

-- Backfill: the surviving active payment per transaction occupies the slot.
-- Prefer a SUCCESS row, else the newest PENDING.
WITH ranked AS (
  SELECT id,
         transaction_id,
         row_number() OVER (
           PARTITION BY transaction_id
           ORDER BY (status = 'SUCCESS') DESC, created_at DESC
         ) AS rn
  FROM "commerce_payments"
  WHERE status IN ('PENDING', 'SUCCESS')
)
UPDATE "commerce_payments" p
SET "active_slot_tx_id" = p.transaction_id
FROM ranked r
WHERE p.id = r.id AND r.rn = 1;

-- Demote pre-existing duplicate PENDING payments (the bug this migration closes) so the
-- unique index can be built. SUCCESS duplicates are intentionally NOT touched — two SUCCESS
-- rows on one transaction is a money bug; the index build below will fail loudly instead.
WITH ranked AS (
  SELECT id,
         status,
         row_number() OVER (
           PARTITION BY transaction_id
           ORDER BY (status = 'SUCCESS') DESC, created_at DESC
         ) AS rn
  FROM "commerce_payments"
  WHERE status IN ('PENDING', 'SUCCESS')
)
UPDATE "commerce_payments" p
SET status = 'CANCELED', updated_at = now()
FROM ranked r
WHERE p.id = r.id AND r.rn > 1 AND p.status = 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payments_active_slot_tx_id_key" ON "commerce_payments" ("active_slot_tx_id");
