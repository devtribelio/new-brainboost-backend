-- A saved copy must absorb the plays the member made on the source, or the
-- playlist shows up twice in recent/top: the source holding the listening rows,
-- the copy holding the ownership. `copied_from_token` cannot carry that link —
-- unshare NULLs the token and rotate replaces it, so the source becomes
-- unfindable — hence a second, stable pointer (docs/playlist-port.md §7).
--
-- No FK, matching `copied_from_token`: the source may be deleted and the copy
-- must not care. A dangling id simply merges nothing.
ALTER TABLE "playlists" ADD COLUMN "copied_from_playlist_id" UUID;

-- Backfill what is still resolvable: copies whose source has neither rotated nor
-- withdrawn its token. The rest stay NULL and keep splitting — the link they
-- needed was never stored, so there is nothing to recover.
UPDATE "playlists" c
   SET "copied_from_playlist_id" = s."id"
  FROM "playlists" s
 WHERE c."copied_from_token" IS NOT NULL
   AND c."copied_from_playlist_id" IS NULL
   AND s."share_token" = c."copied_from_token";
