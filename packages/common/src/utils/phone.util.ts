/**
 * Phone normalization + validation, ported from legacy
 * `TBUtils::sanitizePhone` / `TBUtils::validPhone`.
 *
 * Legacy stored numbers in E.164 (`+62…`). The new schema keeps `phoneCode`
 * and `phone` separate, but WhatsApp delivery (Qontak) and validation still
 * need the combined canonical form.
 */

/**
 * Normalize a phone number to E.164 (`+<prefix><national>`).
 * `prefix` is the default country dial code (digits, with or without `+`).
 *
 * Mirrors legacy rules:
 *   - leading `0`           → drop it, prepend `+<prefix>`
 *   - already starts prefix → prepend `+`
 *   - anything else w/o `+` → prepend `+<prefix>`
 *   - already `+…`          → unchanged
 */
export function sanitizePhone(phone: string, prefix = '62'): string {
  if (prefix.startsWith('+')) prefix = prefix.slice(1);
  if (phone.length === 0) return phone;

  if (phone.startsWith('0')) {
    phone = `+${prefix}${phone.slice(1)}`;
  }
  if (phone.startsWith(prefix)) {
    phone = `+${phone}`;
  }
  if (!phone.startsWith('+')) {
    phone = `+${prefix}${phone}`;
  }
  return phone;
}

/**
 * True when the (sanitized) number is a plausible E.164 number:
 * `+` followed by 7–15 digits. Mirrors legacy regex
 * `^\+(?:[0-9]){6,14}[0-9]$`.
 */
export function isValidPhone(phone: string, prefix = '62'): boolean {
  return /^\+[0-9]{7,15}$/.test(sanitizePhone(phone, prefix));
}

/** Digits-only form Qontak's API expects (e.g. `628111111111`). */
export function toMsisdn(phone: string, prefix = '62'): string {
  return sanitizePhone(phone, prefix).replace(/[^0-9]/g, '');
}
