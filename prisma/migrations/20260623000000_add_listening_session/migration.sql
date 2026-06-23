-- CreateTable
CREATE TABLE "listening_session" (
    "id" UUID NOT NULL,
    "client_session_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "audio_id" UUID NOT NULL,
    "course_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL,
    "listened_sec" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "local_day" DATE NOT NULL,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listening_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listening_session_member_id_local_day_idx" ON "listening_session"("member_id", "local_day");

-- CreateIndex
CREATE INDEX "listening_session_member_id_course_id_local_day_idx" ON "listening_session"("member_id", "course_id", "local_day");

-- CreateIndex
CREATE UNIQUE INDEX "listening_session_member_id_client_session_id_key" ON "listening_session"("member_id", "client_session_id");
