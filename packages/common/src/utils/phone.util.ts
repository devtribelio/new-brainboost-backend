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
  // Defensive: drop a leading 0 left after the country code, e.g. a national
  // number kept its 0 and got the dial code prepended (+62 + 0812 → +620812).
  // Indonesian mobile numbers never start with 0 after the country code.
  if (phone.startsWith(`+${prefix}0`)) {
    phone = `+${prefix}${phone.slice(`+${prefix}0`.length)}`;
  }
  return phone;
}

/**
 * Canonical dial-code form: `+<digits>` (`'62'`, `' +62 '` → `'+62'`).
 * Empty/garbage input collapses to `''`.
 */
export function normalizeDialCode(code: string): string {
  const digits = code.replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Canonical national-number form: digits only, leading zeros dropped
 * (`'08111…'` → `'8111…'`). The schema stores `phone` WITHOUT the dial code;
 * a kept leading 0 would create a second identity for the same number and
 * break exact-match lookups (unique constraint, login by phone).
 */
export function normalizeNationalPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '').replace(/^0+/, '');
}

/**
 * Canonicalize a stored `(phone, phoneCode)` pair:
 *   - `phoneCode` → `'+<digits>'`
 *   - `phone`     → digits only; a leading 0 is dropped, OTHERWISE a duplicated
 *                   dial code is stripped (`'+628111…'`/`'628111…'` with code
 *                   `+62` → `'8111…'`).
 *
 * Branch order mirrors legacy `sanitizePhone`: a leading 0 marks the rest as
 * national (so `0622…` Pematangsiantar keeps its `622` area code), only a
 * 0-less number starting with the dial-code digits counts as E.164-prefixed.
 */
export function normalizePhonePair(
  phone: string,
  phoneCode: string,
): { phone: string; phoneCode: string } {
  const code = normalizeDialCode(phoneCode);
  let national = phone.replace(/[^0-9]/g, '');
  if (national.startsWith('0')) {
    national = national.replace(/^0+/, '');
  } else {
    const codeDigits = code.slice(1);
    if (codeDigits && national.startsWith(codeDigits)) {
      national = national.slice(codeDigits.length).replace(/^0+/, '');
    }
  }
  return { phone: national, phoneCode: code };
}

/**
 * Canonical OTP target for a phone-channel OTP (`otp_codes.target` /
 * `notification_outbox.recipient`): `'+628111…'`. Issue and consume must both
 * build the target through here or the codes never match.
 */
export function otpPhoneTarget(phoneCode: string, phone: string): string {
  const pair = normalizePhonePair(phone, phoneCode);
  return `${pair.phoneCode}${pair.phone}`;
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
