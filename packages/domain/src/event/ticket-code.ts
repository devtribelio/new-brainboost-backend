import crypto from 'node:crypto';

/**
 * Ticket code alphabet: no 0/O and no 1/I. A ticket code is read aloud at a
 * venue door and typed in by hand, which is exactly where those pairs are
 * confused.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const TICKET_CODE_PREFIX = 'BBT';

/**
 * `BBT-XXXXXX`. Minted when the seat is reserved so the "waiting for payment"
 * page can show it; only VALID once the ticket is ISSUED.
 *
 * Uniqueness is enforced by the DB (`event_tickets.code` UNIQUE), not here —
 * 32^6 ≈ 1.07e9 keeps collisions rare, and the caller retries on P2002. Random,
 * not sequential: a guessable code is a free ticket the day check-in is built.
 */
export function generateTicketCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // Modulo bias is negligible at 256 % 32 === 0 — the alphabet length divides
    // the byte range exactly, so this is uniform.
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${TICKET_CODE_PREFIX}-${out}`;
}
