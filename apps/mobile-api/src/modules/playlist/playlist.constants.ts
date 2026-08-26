/**
 * Fallbacks for the runtime-configurable playlist knobs. Every one of these has
 * an `app_settings` row (see `SETTING_KEYS.playlist*`); the constant is only the
 * floor used when the row is missing.
 */

/** Max playlists a member may own. `members.playlist_quota` overrides per member. */
export const PLAYLIST_MAX_PER_MEMBER_DEFAULT = 20;

/** Max audio items in one playlist. Quota alone does not cap total rows. */
export const PLAYLIST_MAX_ITEMS_DEFAULT = 200;

/**
 * Sentinels valid in BOTH quota layers. `0` means "may not create any" and is
 * NOT unlimited — the two are constantly confused, hence the named constants.
 */
export const QUOTA_UNLIMITED = -1;

/** Playlist name bounds. Long enough to be descriptive, short enough for a card. */
export const PLAYLIST_NAME_MAX_CHARS = 80;

/** Visibility values. PUBLIC does not exist: reachable-by-others is share-only. */
export const PLAYLIST_VISIBILITY = {
  private: 'PRIVATE',
  unlisted: 'UNLISTED',
} as const;

/**
 * Share token entropy. 16 random bytes → 22 base64url chars; far past the point
 * where sieving the public share endpoint is worth anyone's time.
 */
export const SHARE_TOKEN_BYTES = 16;
