import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';

/**
 * Bind an attendee's issued tickets to their account, once they have proven
 * they own that mailbox.
 *
 * Called from the email-verification step, which is the only place in the app
 * where an email is proven. Ownership is the ATTENDEE's, not the payer's:
 * buying a ticket for someone else makes you the owner of the order, never of
 * their seat.
 *
 * Idempotent by construction — it only touches rows whose `member_id` is still
 * NULL, so verifying an email twice claims nothing the second time, and a
 * ticket already claimed by its attendee is never reassigned.
 *
 * KNOWN GAP (docs/event-ticketing.md K-3): this is the ONLY claim path today,
 * and a member who signed up with Google or by phone never passes through email
 * verification, so their tickets keep `member_id = NULL`. Phase 2 must either
 * call this from the other activation points or read tickets by verified email
 * as well — do not build "Tiket saya" on the assumption that `member_id` is
 * always filled.
 */
export async function claimTicketsByEmail(memberId: string, email: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 0;

  const { count } = await prisma.eventTicket.updateMany({
    // ISSUED only: a RESERVED ticket belongs to an order that may still expire,
    // and a VOID/EXPIRED one is not a ticket any more.
    where: { attendeeEmail: normalized, status: 'ISSUED', memberId: null },
    data: { memberId },
  });

  if (count > 0) logger.info({ memberId, tickets: count }, '[event] tickets claimed');
  return count;
}
