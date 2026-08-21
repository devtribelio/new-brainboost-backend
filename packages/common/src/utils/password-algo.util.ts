/**
 * Detect the hash algorithm of a legacy `member.password` value by its shape.
 *
 * Legacy (tribelio-platform) writes md5 everywhere (`TBMember.php:1053`,
 * `tribelio-admin/member.php:252`), but ~440 rows carry a PHP `password_hash()`
 * bcrypt digest instead. Stamping those `'legacy'` (= md5 alias in
 * AuthService.verifyPassword) makes the comparison md5(plaintext) vs `$2y$...`,
 * which can never match — the member is locked out for good. So the algo must be
 * derived from the hash, never assumed.
 */
const BCRYPT = /^\$2[aby]\$\d{2}\$/;
const HEX = /^[0-9a-f]+$/i;

export function detectPasswordAlgo(hash: string | null | undefined): string {
  if (!hash) return 'social'; // no password → social-only account (random sentinel hash)
  if (BCRYPT.test(hash)) return 'bcrypt';
  if (HEX.test(hash)) {
    if (hash.length === 40) return 'sha1';
    if (hash.length === 64) return 'sha256';
  }
  // md5 (the legacy default) and anything unrecognised — AuthService treats
  // 'legacy' as md5 and falls back to bcrypt.compare on no match.
  return 'legacy';
}
