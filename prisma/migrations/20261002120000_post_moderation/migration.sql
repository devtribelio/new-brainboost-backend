-- AI moderation of tribe posts (docs/tribe-moderation.md).
-- `posts.publish_status` gains the values IN_REVIEW and REJECTED; it is a
-- free-form text column, so that needs no DDL.

CREATE TABLE "moderation_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "moderation_categories_name_key" ON "moderation_categories"("name");

CREATE TABLE "post_moderations" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "category_name" TEXT,
    "reason" TEXT,
    "decided_by" TEXT NOT NULL DEFAULT 'AI',
    "model" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_moderations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "post_moderations_post_id_key" ON "post_moderations"("post_id");
CREATE INDEX "post_moderations_status_idx" ON "post_moderations"("status");

INSERT INTO "app_settings" ("key", "value", "description", "updated_at") VALUES
  ('moderation.enabled', 'false', 'AI moderation of tribe image posts (''true'' to hold image posts until the model clears them). Also needs baseUrl, model, apiKey and at least one active moderation category.', CURRENT_TIMESTAMP),
  ('moderation.baseUrl', '', 'Base URL of an OpenAI-compatible API, without /chat/completions (e.g. https://api.openai.com/v1).', CURRENT_TIMESTAMP),
  ('moderation.model', '', 'Vision-capable model id sent to the moderation provider.', CURRENT_TIMESTAMP),
  ('moderation.apiKey', '', 'Bearer API key for the moderation provider. Secret.', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
