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

/**
 * Seconds of actual listening before a playlist counts as "played".
 *
 * Small on purpose: it only exists to throw away mis-taps, and it is NOT the
 * streak threshold (600s) — different question, different number. Raising this
 * to the streak value would empty the recent list for anyone who samples.
 */
export const PLAYLIST_PLAYED_MIN_SEC = 30;

/**
 * Default window for the "top" list. Without a window the ranking freezes on
 * whatever someone binged eight months ago and never moves again.
 */
export const PLAYLIST_TOP_RANGE_DAYS = 30;

/** Rows returned by the derived lists unless the caller asks for fewer. */
export const PLAYLIST_HISTORY_LIMIT = 20;

/**
 * The id the app reports when it tracks the interlude — a value the CLIENT can
 * actually see, which the Bunny guid is not.
 *
 * The guid never leaves the server (the app only ever holds an opaque stream
 * token), so a guard that only compares against the guid can never fire: a
 * misbehaving player would send whatever string it happened to have, never the
 * guid. Publishing this sentinel in the detail response gives the client one
 * documented value to use, and gives the ingest guard something it will really
 * see. Underscored so it can never collide with a Lesson uuid.
 */
export const INTERLUDE_AUDIO_ID = '__interlude__';

/**
 * How many distinct course covers a playlist reports for its mosaic tile. Four is
 * what the app's 1/2/3/4 layouts can draw; more would be sent and thrown away.
 */
export const PLAYLIST_COVER_MAX = 4;
