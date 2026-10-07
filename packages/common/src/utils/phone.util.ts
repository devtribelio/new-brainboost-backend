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
 * ITU-T E.164 country calling codes (1–3 digits). Used only to split a legacy value that
 * already carries its own `+<cc>` so a foreign number is not re-prefixed with the default.
 */
const DIAL_CODES: ReadonlySet<string> = new Set([
  '1',
  '7',
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
  '211',
  '212',
  '213',
  '216',
  '218',
  '220',
  '221',
  '222',
  '223',
  '224',
  '225',
  '226',
  '227',
  '228',
  '229',
  '230',
  '231',
  '232',
  '233',
  '234',
  '235',
  '236',
  '237',
  '238',
  '239',
  '240',
  '241',
  '242',
  '243',
  '244',
  '245',
  '246',
  '247',
  '248',
  '249',
  '250',
  '251',
  '252',
  '253',
  '254',
  '255',
  '256',
  '257',
  '258',
  '260',
  '261',
  '262',
  '263',
  '264',
  '265',
  '266',
  '267',
  '268',
  '269',
  '290',
  '291',
  '297',
  '298',
  '299',
  '350',
  '351',
  '352',
  '353',
  '354',
  '355',
  '356',
  '357',
  '358',
  '359',
  '370',
  '371',
  '372',
  '373',
  '374',
  '375',
  '376',
  '377',
  '378',
  '379',
  '380',
  '381',
  '382',
  '383',
  '385',
  '386',
  '387',
  '389',
  '420',
  '421',
  '423',
  '500',
  '501',
  '502',
  '503',
  '504',
  '505',
  '506',
  '507',
  '508',
  '509',
  '590',
  '591',
  '592',
  '593',
  '594',
  '595',
  '596',
  '597',
  '598',
  '599',
  '670',
  '672',
  '673',
  '674',
  '675',
  '676',
  '677',
  '678',
  '679',
  '680',
  '681',
  '682',
  '683',
  '685',
  '686',
  '687',
  '688',
  '689',
  '690',
  '691',
  '692',
  '850',
  '852',
  '853',
  '855',
  '856',
  '880',
  '886',
  '960',
  '961',
  '962',
  '963',
  '964',
  '965',
  '966',
  '967',
  '968',
  '970',
  '971',
  '972',
  '973',
  '974',
  '975',
  '976',
  '977',
  '979',
  '992',
  '993',
  '994',
  '995',
  '996',
  '998',
]);

/** Longest known E.164 prefix (3 → 2 → 1 digits); null when the digits are not a known code. */
function matchDialCode(digits: string): string | null {
  for (const len of [3, 2, 1]) {
    const cc = digits.slice(0, len);
    if (cc.length === len && DIAL_CODES.has(cc)) return cc;
  }
  return null;
}

/**
 * Normalize a phone number IMPORTED FROM LEGACY into a `(phone, phoneCode)` pair, preserving a
 * foreign dial code the value already carries.
 *
 * `normalizePhonePair(raw, '+62')` assumes the default code, so a legacy value like
 * `+2787861310426` becomes `phoneCode='+62'` + national `'2787861310426'` → OTP/WhatsApp target
 * `+62278…` (wrong, and undeliverable). Legacy stored a small set of foreign numbers in full
 * E.164, so when the value starts with `+` we split on the number's OWN code. A `+62…` value, a
 * leading `0`, or a bare national number still goes through `normalizePhonePair` unchanged.
 */
export function normalizeLegacyPhonePair(
  rawPhone: string,
  defaultCode = '+62',
): { phone: string; phoneCode: string } | null {
  const trimmed = (rawPhone ?? '').trim();
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+') && !digits.startsWith('62')) {
    const cc = matchDialCode(digits);
    const national = cc ? digits.slice(cc.length).replace(/^0+/, '') : '';
    if (cc && national) return { phone: national, phoneCode: `+${cc}` };
  }
  return normalizePhonePair(trimmed, defaultCode);
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
