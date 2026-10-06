/**
 * Legacy bank keys (TBBank: `bca`, `mandiri`, `mandiri-syariah`, `standard-chartered`, …)
 * → the uppercase codes Xendit and the app use (`BCA`, `MANDIRI`, `BSI`, …).
 * Both `member.bank_account_bank` and `member_data_kyc.bank_type` carry the same keys
 * (tribelio-admin reads them interchangeably via IFNULL).
 */
const ALIASES: Record<string, string> = {
  'mandiri-syariah': 'BSI', // merged into Bank Syariah Indonesia
  bankbtn: 'BTN',
};

/** Known aliases mapped, everything else uppercased with `-` → `_`. Blank → null. */
export function normalizeBankCode(raw: string | null | undefined): string | null {
  const key = raw?.trim().toLowerCase();
  if (!key) return null;
  return ALIASES[key] ?? key.toUpperCase().replace(/-/g, '_');
}
