/**
 * Semver comparison + update-verdict resolution for `GET /api/app/version-check`.
 * Pure — no DB, no Express — so the verdict table can be tested exhaustively.
 */

export const UPDATE_VERDICTS = ['none', 'soft', 'force'] as const;
export type UpdateVerdict = (typeof UPDATE_VERDICTS)[number];

export interface VersionConfigInput {
  latestVersion: string;
  forceBelow?: string | null;
}

/**
 * Parse `1.2.3` / `1.2` into numeric segments. A pre-release/build suffix
 * (`3.3.0-beta.1`, `3.3.0+42`) is dropped: we only ever gate on the release triple.
 * Returns null when the string isn't a version at all.
 */
export function parseVersion(raw: string | undefined | null): number[] | null {
  if (typeof raw !== 'string') return null;
  const core = raw.trim().split(/[-+]/, 1)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  const parts = core.split('.').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/**
 * Numeric per-segment compare (so 3.10.0 > 3.9.9, which a string compare gets wrong).
 * Missing trailing segments count as 0 — `3.2` equals `3.2.0`.
 * Returns -1 / 0 / 1, or null when either side is unparseable.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * The verdict, in the order the contract specifies:
 *   version < forceBelow     -> force
 *   version < latestVersion  -> soft
 *   otherwise                -> none
 *
 * Both comparisons are STRICT: a client sitting exactly on a threshold is not nagged.
 * An unparseable installed version yields `none` rather than an error — a malformed
 * version string from some old build must never trap a user behind a force dialog.
 */
export function resolveVerdict(installedVersion: string, config: VersionConfigInput): UpdateVerdict {
  if (!parseVersion(installedVersion)) return 'none';
  if (config.forceBelow && compareSemver(installedVersion, config.forceBelow) === -1) return 'force';
  if (compareSemver(installedVersion, config.latestVersion) === -1) return 'soft';
  return 'none';
}
