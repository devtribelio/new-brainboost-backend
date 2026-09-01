-- Deleting a playlist saved from a share used to hand the card straight back: the
-- plays that put it in recent sit on the SOURCE id, and the source is still shared
-- by its owner, so the merge simply stopped and the source re-appeared on its own.
-- A dismissal row records "I deleted this" against the source.
--
-- Deliberately not a DELETE of the member's listening_session rows: that table also
-- feeds streak and lifetime counters, so tidying one list would move numbers that
-- have nothing to do with playlists.
--
-- No FK on either column: the source may be deleted afterwards and a dangling row
-- matches nothing. `dismissed_at` is compared against the newest play, so a member
-- who returns to the share link sees the playlist again instead of being blocked.
CREATE TABLE "playlist_history_dismissals" (
  "member_id"    UUID         NOT NULL,
  "playlist_id"  UUID         NOT NULL,
  "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "playlist_history_dismissals_pkey" PRIMARY KEY ("member_id", "playlist_id")
);
