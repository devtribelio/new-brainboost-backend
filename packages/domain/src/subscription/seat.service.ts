import { Prisma, type SubscriptionSeat } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@bb/common/exceptions';

// Shared manually (WA/chat) — no ambiguous chars (0/O/1/I).
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 10;

export interface InviteResult {
  inviteCode: string;
  seatNo: number;
  subscriptionId: string;
}

/**
 * Seat occupancy management (PRD BE-05) — Spotify-Family style sharing on the
 * pre-provisioned `subscription_seats` slots created by SubscriptionService.
 *
 * Concurrency model: claiming is a single conditional UPDATE (`inviteCode = code
 * AND member_id IS NULL`) — Postgres row locking makes exactly one concurrent
 * claimer win; the invite code is NULLed in the same statement (single-use).
 * The partial unique `uniq_active_seat_per_member` backstops "one seat per
 * member" across ALL subscriptions.
 */
export class SeatService {
  /**
   * Write a fresh invite code onto the owner's first empty slot. Rotating:
   * every call mints a new code, killing the previous one (it's overwritten).
   */
  async generateInvite(ownerId: string): Promise<InviteResult> {
    const sub = await this.activeSubOrThrow(ownerId);

    const seat = await prisma.subscriptionSeat.findFirst({
      where: { subscriptionId: sub.id, memberId: null },
      orderBy: { seatNo: 'asc' },
    });
    if (!seat) throw new BadRequestException('Semua seat sudah terisi');

    // Retry the (astronomically rare) global invite-code collision.
    for (let attempt = 0; ; attempt++) {
      const inviteCode = generateInviteCode();
      try {
        await prisma.subscriptionSeat.update({
          where: { id: seat.id },
          data: { inviteCode },
        });
        return { inviteCode, seatNo: seat.seatNo, subscriptionId: sub.id };
      } catch (e) {
        if (isP2002(e) && attempt < 2) continue;
        throw e;
      }
    }
  }

  /** Claim the seat carrying `code`. Exactly one concurrent claimer wins. */
  async claimSeat(memberId: string, code: string): Promise<SubscriptionSeat> {
    const seat = await prisma.subscriptionSeat.findUnique({
      where: { inviteCode: code },
      include: { subscription: true },
    });
    if (!seat) throw new BadRequestException('Kode undangan tidak valid');

    const sub = seat.subscription;
    if (sub.status !== 'ACTIVE' || (sub.graceUntil ?? sub.expiresAt) <= new Date()) {
      throw new BadRequestException('Subscription tidak aktif');
    }
    if (sub.ownerId === memberId) {
      throw new BadRequestException('Kamu adalah pemilik subscription ini (sudah menempati seat 1)');
    }

    // Release the claimer's zombie seat (on an expired/canceled sub) first — it
    // grants nothing but would trip uniq_active_seat_per_member below.
    await prisma.subscriptionSeat.updateMany({
      where: { memberId, subscription: { NOT: { status: 'ACTIVE' } } },
      data: { memberId: null, claimedAt: null },
    });

    let claimed: number;
    try {
      // The atomic decision point — see class doc.
      const res = await prisma.subscriptionSeat.updateMany({
        where: { inviteCode: code, memberId: null },
        data: { memberId, claimedAt: new Date(), inviteCode: null },
      });
      claimed = res.count;
    } catch (e) {
      if (isP2002(e)) {
        // uniq_active_seat_per_member — claimer already holds a seat somewhere.
        throw new BadRequestException('Kamu sudah tergabung di subscription lain');
      }
      throw e;
    }
    if (claimed === 0) throw new BadRequestException('Kode undangan sudah dipakai');

    logger.info(
      { memberId, subscriptionId: sub.id, seatNo: seat.seatNo },
      '[subscription] seat claimed',
    );
    return prisma.subscriptionSeat.findUniqueOrThrow({ where: { id: seat.id } });
  }

  /** Owner kicks a member off a seat. Seat 1 (the owner) can't be removed. */
  async removeSeat(ownerId: string, seatId: string): Promise<void> {
    const seat = await prisma.subscriptionSeat.findUnique({
      where: { id: seatId },
      include: { subscription: true },
    });
    if (!seat) throw new NotFoundException('Seat tidak ditemukan');
    if (seat.subscription.ownerId !== ownerId) {
      throw new ForbiddenException('Bukan subscription milikmu');
    }
    if (seat.seatNo === 1) throw new BadRequestException('Seat owner tidak bisa dihapus');
    if (!seat.memberId) throw new BadRequestException('Seat ini kosong');

    await this.freeSeat(seat.id, seat.subscriptionId, seat.memberId);
    logger.info(
      { ownerId, seatId, removedMemberId: seat.memberId },
      '[subscription] seat removed by owner',
    );
  }

  /** Member walks away from their seat. The owner's exit path is cancel, not leave. */
  async leaveSeat(memberId: string): Promise<void> {
    const seat = await prisma.subscriptionSeat.findFirst({
      where: { memberId },
      include: { subscription: true },
    });
    if (!seat) throw new BadRequestException('Kamu tidak menempati seat mana pun');
    if (seat.seatNo === 1) {
      throw new BadRequestException(
        'Owner tidak bisa keluar dari subscription sendiri — gunakan cancel',
      );
    }

    await this.freeSeat(seat.id, seat.subscriptionId, memberId);
    logger.info({ memberId, seatId: seat.id }, '[subscription] member left seat');
  }

  // --- internals ------------------------------------------------------------------

  /**
   * Vacate the slot and cut the leaver's subscription-driven access NOW:
   * their lazy enrollments on this sub get expired_date = now (retail rows —
   * via_subscription_id NULL — are never touched, per the sacred BE-06 rule).
   */
  private async freeSeat(seatId: string, subscriptionId: string, memberId: string): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.subscriptionSeat.update({
        where: { id: seatId },
        data: { memberId: null, claimedAt: null, inviteCode: null },
      }),
      prisma.courseEnrollment.updateMany({
        where: { viaSubscriptionId: subscriptionId, memberId },
        data: { expiredDate: now },
      }),
    ]);
  }

  private async activeSubOrThrow(ownerId: string) {
    const sub = await prisma.memberSubscription.findFirst({
      where: { ownerId, status: 'ACTIVE' },
    });
    if (!sub || (sub.graceUntil ?? sub.expiresAt) <= new Date()) {
      throw new BadRequestException('Subscription tidak aktif');
    }
    return sub;
  }
}

function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_LENGTH; i++) {
    out += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return out;
}

function isP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
