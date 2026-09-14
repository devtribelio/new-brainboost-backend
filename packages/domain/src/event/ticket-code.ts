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
 *
 * `randomInt` rejection-samples rather than `randomBytes()[i] % 32`. The modulo
 * was already unbiased (256 % 32 === 0), but the shape is the one that silently
 * breaks the day someone edits the alphabet to a length that does not divide
 * 256 — and it is what CodeQL flags (`js/biased-cryptographic-random`).
 */
export function generateTicketCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `${TICKET_CODE_PREFIX}-${out}`;
}
