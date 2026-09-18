/**
 * Value rewriting for the account soft delete (`purgeScheduledDeletions`).
 *
 * Two classes of column, and the difference is the whole design:
 *
 *  - UNIQUE columns (`email`, `phone`, `username`) go through here. They cannot
 *    simply be blanked to a shared sentinel — a second deleted account would
 *    collide on the unique index (P2002) and the purge job would fail, silently,
 *    because jobs-runner catches per-job errors and moves on. So every value is
 *    prefixed with the member's own UUID, which is unique by construction: two
 *    rows can never produce the same string, no matter how many times the same
 *    address is registered and deleted.
 *
 *  - NON-unique PII (`full_name`, `bio`, `bank_*`, `kyc_*`, …) does NOT come here.
 *    It is simply set to NULL by the job — there is no constraint to work around
 *    and no reason to keep a trace of it.
 *
 * The masked tail is what backoffice reads: enough for a human to recognise the
 * row when a complaint comes in (domain, first letter, last digits), not enough
 * to contact or identify the person. The original value is NOT recoverable from
 * it, which is the point — this runs as part of a deletion.
 *
 * Shape note: `del:<uuid>:<mask>` is deliberately NOT a valid email address (the
 * colons sit in what would be the local part). If some outbound path ever fails
 * to filter deleted members, it fails validation instead of actually mailing a
 * live domain and generating bounces. A `deleted_123_foo@gmail.com` style prefix
 * would still be syntactically deliverable.
 */

const PREFIX = 'del';

/** Already-anonymised values pass through untouched, so a re-run can't double-prefix. */
function isAnonymized(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

function wrap(memberId: string, masked: string): string {
  return `${PREFIX}:${memberId}:${masked}`;
}

/** `budi` → `b***`, `b` → `b***`. Keeps one leading character, never more. */
function maskLocal(local: string): string {
  return `${local.slice(0, 1)}***`;
}

/**
 * `budi@gmail.com` → `b***@gmail.com`. The domain survives on purpose: it is the
 * part support actually uses to recognise a row, and it identifies a provider
 * rather than a person.
 *
 * A value with no `@` is not an address we can reason about, so it is masked
 * whole rather than guessed at.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return maskLocal(email);
  return `${maskLocal(email.slice(0, at))}@${email.slice(at + 1)}`;
}

/**
 * `81234567890` → `8123****890`. Head and tail survive because that is what a
 * member reads back to support over the phone; the middle is what makes a number
 * dialable.
 *
 * Short values keep only one digit each side — masking must never leave a number
 * that is still complete enough to call.
 */
export function maskPhone(phone: string): string {
  const digits = phone.trim();
  if (digits.length <= 4) return '****';
  if (digits.length <= 8) return `${digits.slice(0, 1)}****${digits.slice(-1)}`;
  return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
}

/** `budianto` → `bu***`. */
export function maskUsername(username: string): string {
  return `${username.slice(0, 2)}***`;
}

/**
 * Final stored values for the three unique columns. `null` in → `null` out: a
 * member who never had a phone has nothing to free and nothing to record.
 */
export function anonymizeEmail(memberId: string, email: string | null): string | null {
  if (!email) return null;
  return isAnonymized(email) ? email : wrap(memberId, maskEmail(email));
}

export function anonymizePhone(memberId: string, phone: string | null): string | null {
  if (!phone) return null;
  return isAnonymized(phone) ? phone : wrap(memberId, maskPhone(phone));
}

export function anonymizeUsername(memberId: string, username: string | null): string | null {
  if (!username) return null;
  return isAnonymized(username) ? username : wrap(memberId, maskUsername(username));
}
