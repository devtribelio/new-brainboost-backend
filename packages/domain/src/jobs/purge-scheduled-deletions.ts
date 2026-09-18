import { randomBytes } from 'node:crypto';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import {
  anonymizeEmail,
  anonymizePhone,
  anonymizeUsername,
  maskEmail,
  maskPhone,
} from '@bb/common/utils/anonymize.util';

/** How many accounts one tick will execute. Keeps a single cron run bounded. */
const BATCH_LIMIT = 200;

/**
 * Execute the soft delete for accounts whose grace period has run out.
 *
 * This is a SOFT delete on purpose, and "soft" here does not mean "a flag":
 * the `members` row survives with every foreign key intact, but the PII on it is
 * overwritten and gone. That split is what lets the same job satisfy two things
 * that a hard delete cannot satisfy together:
 *
 *  - The financial record stays whole. `commerce_transactions`, `commerce_payments`,
 *    `affiliate_commissions`, `affiliate_disbursements` and `kyc_event` all point at
 *    this row; four of those FKs are ON DELETE RESTRICT, so a real DELETE would be
 *    refused for any member who ever transacted, and the CASCADE ones would take the
 *    payout ledger and the AML trail with them.
 *  - The affiliate tree stays whole. `members.inviter_id` is ON DELETE SET NULL, so a
 *    hard delete of a mid-chain member would sever `walkInviterChain` and silently
 *    stop every upline above them from ever earning on that downline again.
 *
 * What survives is the MONEY and the RELATIONSHIPS; what does not is the IDENTITY.
 * Commissions, enrollments, order history, the affiliate code and the inviter chain are
 * all left exactly as they were — so support can put a purged account back into service
 * later. That is re-onboarding onto an existing row, not an undelete: the email, phone,
 * password, social links, bank details and KYC documents are gone and cannot be restored
 * from anything stored here, so the person has to supply them again.
 *
 * Self-service recovery still ends at the deadline (log in → banner →
 * `recoverAccountScheduled`); past it, only support can reopen the row.
 */
export async function purgeScheduledDeletions(
  now: Date = new Date(),
  limit: number = BATCH_LIMIT,
): Promise<{ purged: number; skipped: number; failed: number }> {
  const due = await prisma.member.findMany({
    where: { deletedAt: null, scheduledDeletionAt: { not: null, lte: now } },
    select: { id: true },
    orderBy: { scheduledDeletionAt: 'asc' },
    take: limit,
  });

  let purged = 0;
  let skipped = 0;
  let failed = 0;

  for (const { id } of due) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        // Claim the row FIRST, conditionally. Between the scan above and here the
        // member may have logged in and cancelled (the login recovery path clears
        // `scheduledDeletionAt`). Zero rows matched means they got there first, and
        // we must not anonymise a live account. This is the same conditional-update
        // gate the refresh-token rotation and the voucher redeem use.
        const claimed = await tx.member.updateMany({
          where: { id, deletedAt: null, scheduledDeletionAt: { not: null, lte: now } },
          data: { deletedAt: now },
        });
        if (claimed.count === 0) return false;

        // Re-read inside the transaction: the values fetched during the scan may be
        // stale, and these are the exact strings we are about to destroy.
        const member = await tx.member.findUniqueOrThrow({
          where: { id },
          select: { id: true, email: true, phone: true, username: true, kycStatus: true },
        });
        const oldEmail = member.email;
        // Only an APPROVED stamp is revoked. NONE / REJECTED have nothing to revoke, and
        // PENDING is already blocked by the payout gate (only APPROVED passes) — same
        // no-op rule as `DisbursementService.resetKyc`.
        const revokeKyc = member.kycStatus === 'APPROVED';

        await tx.member.update({
          where: { id },
          data: {
            // --- unique columns: rewritten, never blanked (see anonymize.util) ---
            email: anonymizeEmail(id, member.email),
            phone: anonymizePhone(id, member.phone),
            username: anonymizeUsername(id, member.username),
            // Opaque provider tokens. Nothing in backoffice can read meaning out of a
            // Google subject id, so there is nothing to preserve — and leaving them set
            // would block the person from ever signing up again with the same Google or
            // Apple account, failing as an unexplained 409 on a column they cannot see.
            googleSub: null,
            appleSub: null,
            kycProviderRef: null,

            // --- non-unique PII: simply gone ---
            phoneCode: null,
            fullName: null,
            avatarUrl: null,
            coverUrl: null,
            bio: null,
            birthdate: null,
            gender: null,
            latitude: null,
            longitude: null,
            bankCode: null,
            bankAccountNumber: null,
            bankAccountName: null,
            kycIdNumber: null,
            kycIdType: null,
            kycIdCardUrl: null,
            kycSelfieUrl: null,

            // The APPROVED stamp cannot outlive the documents that earned it. The payout
            // gate is one line — `kycStatus !== 'APPROVED'` — so leaving it APPROVED means
            // an account restored over the counter can withdraw immediately with no KYC on
            // file at all. EXPIRED already means "was approved, must re-verify" and the
            // gate answers KYC_EXPIRED for it.
            ...(revokeKyc
              ? { kycStatus: 'EXPIRED', kycReviewedAt: null, kycRejectedReason: null }
              : {}),

            // Both flags describe an address and a number that no longer exist on this row.
            // Left true, a restored account given a NEW email would inherit a verified
            // stamp for a mailbox nobody has proven.
            isEmailVerified: false,
            isPhoneVerified: false,

            // Not NULL-able, and `passwordAlgo: 'deleted'` makes verifyPassword refuse
            // before the hash is ever compared. The random value is belt-and-braces so
            // the column holds nothing derived from the real password either.
            passwordHash: randomBytes(32).toString('hex'),
            passwordAlgo: 'deleted',
            isActive: false,
          },
        });

        await tx.memberProfile.updateMany({
          where: { memberId: id },
          data: { address: null, postalCode: null },
        });

        // Commission rows are deliberately NOT touched — not voided, not restated. The
        // commission was genuinely earned at sale time, so the expense stays booked and
        // every finance report keeps reading the numbers it read yesterday. Voiding would
        // have been a write-off in a later period than the one it undoes, and it would
        // have to be reversed again the moment an account is restored over the counter.
        // Nothing needs it either: the balance is already unreachable because the account
        // cannot log in.
        //
        // Consequence to accept: `affiliatePendingToBalance` does not filter deleted rows,
        // so PENDING commission keeps clearing to BALANCE on schedule. Under this design
        // that is correct — the hold elapsed, the money is owed, it is simply unclaimed —
        // but "commission owed" totals will carry balances for accounts that mostly never
        // come back.
        //
        // A payout still awaiting approval is a different matter and DOES die here. Safety
        // stop, not bookkeeping: `affiliate_disbursements` snapshots the bank details at
        // request time, so clearing `members.bank_*` above does nothing to stop it, and
        // `executeApprovedDisbursements` gates only on `kycStatus`. Wiring money to a
        // snapshotted account whose owner can no longer be verified is the one outcome
        // here that cannot be undone. VOIDED also releases the held balance, so a restored
        // account finds its money available again — the request was cancelled, not the money.
        //
        // Only PENDING. PROCESSING is already at Xendit and voiding our row would not
        // recall it — the callback still has to land on a row it recognises.
        const voidedPayouts = await tx.affiliateDisbursement.updateMany({
          where: { memberId: id, status: 'PENDING' },
          data: { status: 'VOIDED', failureReason: 'Akun dihapus' },
        });

        // Append-only AML trail, the same shape `resetKyc` writes. Inline rather than a
        // call to that method because it opens its own transaction, and this reset has to
        // commit or roll back with the anonymisation it belongs to.
        if (revokeKyc) {
          await tx.kycEvent.create({
            data: {
              memberId: id,
              type: 'RESET',
              reason: 'ACCOUNT_DELETED',
              fromStatus: 'APPROVED',
              toStatus: 'EXPIRED',
              actorType: 'SYSTEM',
            },
          });
        }

        if (voidedPayouts.count > 0 || revokeKyc) {
          logger.info(
            { memberId: id, payoutsVoided: voidedPayouts.count, kycRevoked: revokeKyc },
            '[account-purge] cancelled pending payout / revoked KYC',
          );
        }

        // The order's own contact snapshot. This sweep is REQUIRED, not cosmetic:
        // `mayReadOrder` (event.service.ts) accepts `buyer_email` as a credential for
        // GET /api/event/order/:code, and order codes are enumerable (a per-day
        // counter). Leaving it while freeing the address for re-registration would let
        // whoever next registers that email open the old owner's order page, which
        // lists every attendee's name and email.
        const orders = await tx.commerceTransaction.findMany({
          where: { memberId: id },
          select: { id: true, buyerEmail: true, buyerPhone: true },
        });
        for (const o of orders) {
          if (!o.buyerEmail && !o.buyerPhone) continue;
          await tx.commerceTransaction.update({
            where: { id: o.id },
            data: {
              buyerEmail: o.buyerEmail ? `del:${id}:${maskEmail(o.buyerEmail)}` : null,
              buyerPhone: o.buyerPhone ? `del:${id}:${maskPhone(o.buyerPhone)}` : null,
            },
          });
        }

        // Attendee rows, but ONLY this member's own. A ticket the member BOUGHT for
        // somebody else carries that third party's name and phone; they did not ask to
        // be deleted, so their row is left alone. Two ways a ticket is "theirs":
        // `member_id` (claimed), or bought by them AND addressed to their own mailbox
        // (bought for self, never claimed — `member_id` is still null there).
        const tickets = await tx.eventTicket.findMany({
          where: {
            OR: [
              { memberId: id },
              oldEmail
                ? { buyerMemberId: id, attendeeEmail: { equals: oldEmail, mode: 'insensitive' } }
                : { id: '00000000-0000-0000-0000-000000000000' },
            ],
          },
          select: { id: true, attendeeEmail: true, attendeePhone: true },
        });
        for (const t of tickets) {
          await tx.eventTicket.update({
            where: { id: t.id },
            data: {
              attendeeName: 'Pengguna dihapus',
              // NOT NULL, so it is rewritten rather than cleared. Masking it also
              // retires it as a claim key — nothing can be handed over to a recycled
              // mailbox on the strength of this row.
              attendeeEmail: `del:${id}:${maskEmail(t.attendeeEmail)}`,
              attendeePhone: t.attendeePhone ? `del:${id}:${maskPhone(t.attendeePhone)}` : null,
            },
          });
        }

        return true;
      });

      if (done) purged++;
      else skipped++;
    } catch (err) {
      // Per-member, so one bad row cannot strand the rest of the batch. The claim and
      // the rewrite share a transaction, so a failure here leaves the row untouched
      // and the next tick retries it.
      failed++;
      logger.error({ err, memberId: id }, '[account-purge] failed to anonymise member');
    }
  }

  if (purged > 0 || failed > 0) {
    logger.info({ purged, skipped, failed }, '[account-purge] executed scheduled deletions');
  }
  return { purged, skipped, failed };
}
