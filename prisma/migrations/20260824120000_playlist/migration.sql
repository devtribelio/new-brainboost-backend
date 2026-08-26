-- Playlist (docs/playlist-port.md). Member-built (UGC) only: no curated variant,
-- hence owner_id NOT NULL. Playing/creating is gated on an active subscription.

CREATE TABLE "playlists" (
  "id"                UUID         NOT NULL,
  "owner_id"          UUID         NOT NULL,
  "visibility"        TEXT         NOT NULL DEFAULT 'PRIVATE',
  "share_token"       TEXT,
  "shared_at"         TIMESTAMP(3),
  "copied_from_token" TEXT,
  "name"              TEXT         NOT NULL,
  "description"       TEXT,
  "cover_url"         TEXT,
  "sort_order"        INTEGER      NOT NULL DEFAULT 0,
  "is_active"         BOOLEAN      NOT NULL DEFAULT true,
  "is_blocked"        BOOLEAN      NOT NULL DEFAULT false,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "playlists_share_token_key" ON "playlists"("share_token");
CREATE INDEX "playlists_owner_id_idx" ON "playlists"("owner_id");
CREATE INDEX "playlists_is_active_sort_order_idx" ON "playlists"("is_active", "sort_order");

ALTER TABLE "playlists"
  ADD CONSTRAINT "playlists_owner_id_fkey" FOREIGN KEY ("owner_id")
  REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "playlist_items" (
  "id"          UUID    NOT NULL,
  "playlist_id" UUID    NOT NULL,
  "lesson_id"   UUID    NOT NULL,
  "order"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "playlist_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "playlist_items_playlist_id_lesson_id_key"
  ON "playlist_items"("playlist_id", "lesson_id");
CREATE INDEX "playlist_items_playlist_id_order_idx"
  ON "playlist_items"("playlist_id", "order");

ALTER TABLE "playlist_items"
  ADD CONSTRAINT "playlist_items_playlist_id_fkey" FOREIGN KEY ("playlist_id")
  REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playlist_items"
  ADD CONSTRAINT "playlist_items_lesson_id_fkey" FOREIGN KEY ("lesson_id")
  REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-member override for the playlist cap. NULL = follow app_settings
-- `playlist.maxPerMember`. -1 = unlimited, 0 = may not create any (NOT unlimited).
ALTER TABLE "members" ADD COLUMN "playlist_quota" INTEGER;

-- Which playlist an audio was played from. No FK: the ingest log must never fail
-- because the playlist row was deleted. Feeds the derived recent/top lists.
ALTER TABLE "listening_session" ADD COLUMN "playlist_id" UUID;
CREATE INDEX "listening_session_member_id_playlist_id_started_at_idx"
  ON "listening_session"("member_id", "playlist_id", "started_at");
