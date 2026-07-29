-- Idempotency guard for FCM push delivery. SQS Standard queues are at-least-once,
-- so apps/notification-worker claims a row here (unique insert on the outbox
-- message id) BEFORE calling FCM — a redelivered message hits the PK and is a
-- no-op instead of pushing the same recap twice. Mirrors "comms_idempotency".
CREATE TABLE "push_idempotency" (
    "message_id" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_idempotency_pkey" PRIMARY KEY ("message_id")
);
