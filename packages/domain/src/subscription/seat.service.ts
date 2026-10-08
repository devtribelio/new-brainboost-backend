import {
  Prisma,
  type MemberSubscription,
  type SubscriptionPlan,
  type SubscriptionSeat,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  badRequest,
  ERROR_CODES,
} from '@bb/common/exceptions';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/** Fallback for `subscription.maxSeatChanges` when the setting row is absent. */
export const MAX_SEAT_CHANGES_DEFAULT = 2;

/**
 * Seat-resale deterrent (2026-10-08). An owner selling the guest seat in
 * 3-month slices needs to rotate occupants; each rotation is a VACATE (owner
 * remove or member leave — leave counts too, or "just leave by yourself" makes
 * the rule hollow). The counter lives on the subscription for the current term,
 * resets with renewal/plan change, and gates invite + claim at the cap. It never
 * gates remove/leave: an owner must always be able to kick an abuser and a
 * member must always be able to walk away — the price is an empty seat until
 * renewal, which is the deterrent. System vacates (downgrade eviction, expiry)
 * do not count.
 */
export interface SeatChanges {
  used: number;
  max: number;
  remaining: number;
}

// Shared manually (WA/chat) — no ambiguous chars (0/O/1/I).
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 10;

export interface RemovedSeat {
  /** The member who just lost the seat. */
  memberId: string;
  subscription: MemberSubscription & { plan: SubscriptionPlan };
  /** Counter after this removal — the number the owner's screen must show next. */
  seatChanges: SeatChanges;
}

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
    await this.assertSeatChangesLeft(sub);

    // `seatNo <= plan.seatCount` is the allowance, not the row count: a tier
    // change can leave MORE rows than the new plan allows, because `changePlan`
    // only ever drops EMPTY slots — a Family→Solo with 3 occupied seats keeps
    // all three. When one of those over-limit members later leaves, their slot
    // must not become invitable again, which is exactly the revenue leak.
    const seat = await prisma.subscriptionSeat.findFirst({
      where: { subscriptionId: sub.id, memberId: null, seatNo: { lte: sub.plan.seatCount } },
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
      include: {
        subscription: { include: { plan: { select: { seatCount: true, maxSeatChanges: true } } } },
      },
    });
    if (!seat) throw new BadRequestException('Kode undangan tidak valid');

    const sub = seat.subscription;
    if (sub.status !== 'ACTIVE' || (sub.graceUntil ?? sub.expiresAt) <= new Date()) {
      throw new BadRequestException('Subscription tidak aktif');
    }
    // Backstop for a code minted before a tier change shrank the allowance (the
    // seatNo filter in generateInvite only guards fresh invites). Checking the
    // seat NUMBER rather than counting occupants keeps this race-free: each code
    // belongs to exactly one row, so two concurrent claimers can never both slip
    // past a count that was true when they read it.
    if (seat.seatNo > sub.plan.seatCount) {
      throw new BadRequestException('Kode undangan sudah tidak berlaku — jatah seat paket ini sudah penuh');
    }
    if (sub.ownerId === memberId) {
      throw new BadRequestException('Kamu adalah pemilik subscription ini (sudah menempati seat 1)');
    }
    // A code minted before the cap was hit must not slip through.
    await this.assertSeatChangesLeft(sub);

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

    await prisma.subscriptionSeatEvent.create({
      data: {
        subscriptionId: sub.id,
        seatNo: seat.seatNo,
        kind: 'claim',
        memberId,
        actorId: memberId,
        seatChanges: sub.seatChanges,
      },
    });
    logger.info(
      { memberId, subscriptionId: sub.id, seatNo: seat.seatNo },
      '[subscription] seat claimed',
    );
    return prisma.subscriptionSeat.findUniqueOrThrow({ where: { id: seat.id } });
  }

  /**
   * Owner picks which seats survive the pending downgrade. The selection is
   * stored on the seats and only READ when the change actually lands, so it
   * self-corrects: a member who leaves in the meantime takes their mark with
   * them, and the fallback rule fills whatever is left over.
   *
   * The owner's own seat is never part of the choice — they pay the bill, and
   * offering it as an option only invites them to lock themselves out.
   */
  async choosePendingSeats(ownerId: string, seatIds: string[]): Promise<void> {
    const sub = await prisma.memberSubscription.findFirst({
      where: { ownerId, status: 'ACTIVE' },
    });
    if (!sub) throw new BadRequestException('Tidak ada subscription aktif');
    if (!sub.pendingPlanId) throw new BadRequestException('Tidak ada perubahan paket terjadwal');

    const pendingPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { id: sub.pendingPlanId },
    });
    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: sub.id, id: { in: seatIds } },
    });
    if (seats.length !== seatIds.length) {
      throw new BadRequestException('Ada seat yang bukan milik subscription ini');
    }
    const chosen = seats.filter((s) => s.memberId !== null && s.memberId !== ownerId);
    // +1 for the owner's seat, which is kept unconditionally.
    if (chosen.length + 1 > pendingPlan.seatCount) {
      throw new BadRequestException(
        `Paket ${pendingPlan.tier} hanya punya ${pendingPlan.seatCount} seat — pilih maksimal ${pendingPlan.seatCount - 1} anggota`,
      );
    }

    const chosenIds = chosen.map((s) => s.id);
    await prisma.$transaction([
      prisma.subscriptionSeat.updateMany({
        where: { subscriptionId: sub.id },
        data: { pendingKeep: false },
      }),
      prisma.subscriptionSeat.updateMany({
        where: { id: { in: chosenIds } },
        data: { pendingKeep: true },
      }),
    ]);
    logger.info(
      { ownerId, subscriptionId: sub.id, kept: chosenIds.length },
      '[subscription] owner chose seats for the pending downgrade',
    );
  }

  /**
   * Owner kicks a member off a seat. Seat 1 (the owner) can't be removed.
   *
   * Returns who was removed and on which subscription so the caller can announce
   * it — losing access this way used to be the only silent one of the three
   * (tier change and expiry both notify), and it is the most personal of them.
   * Emission stays with the caller, matching the rest of the module: services
   * commit, callers announce.
   */
  async removeSeat(ownerId: string, seatId: string): Promise<RemovedSeat> {
    const seat = await prisma.subscriptionSeat.findUnique({
      where: { id: seatId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!seat) throw new NotFoundException('Seat tidak ditemukan');
    if (seat.subscription.ownerId !== ownerId) {
      throw new ForbiddenException('Bukan subscription milikmu');
    }
    if (seat.seatNo === 1) throw new BadRequestException('Seat owner tidak bisa dihapus');
    if (!seat.memberId) throw new BadRequestException('Seat ini kosong');

    const seatChanges = await this.freeSeat(seat, { kind: 'remove', actorId: ownerId });
    logger.info(
      { ownerId, seatId, removedMemberId: seat.memberId, seatChanges: seatChanges.used },
      '[subscription] seat removed by owner',
    );
    return { memberId: seat.memberId, subscription: seat.subscription, seatChanges };
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

    const seatChanges = await this.freeSeat(seat, { kind: 'leave', actorId: memberId });
    logger.info(
      { memberId, seatId: seat.id, seatChanges: seatChanges.used },
      '[subscription] member left seat',
    );
  }

  /** The owner's counter for the term, as `/me` and the remove response render it. */
  async seatChangesOf(subscriptionId: string): Promise<SeatChanges> {
    const sub = await prisma.memberSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      select: { seatChanges: true, plan: { select: { maxSeatChanges: true } } },
    });
    return this.toSeatChanges(sub);
  }

  // --- internals ------------------------------------------------------------------

  /**
   * Vacate the slot and cut the leaver's subscription-driven access NOW:
   * their lazy enrollments on this sub get expired_date = now (retail rows —
   * via_subscription_id NULL — are never touched, per the sacred BE-06 rule).
   */
  private async freeSeat(
    seat: { id: string; subscriptionId: string; seatNo: number; memberId: string | null },
    by: { kind: 'remove' | 'leave'; actorId: string },
  ): Promise<SeatChanges> {
    const now = new Date();
    const memberId = seat.memberId as string;
    const bumped = await prisma.$transaction(async (tx) => {
      await tx.subscriptionSeat.update({
        where: { id: seat.id },
        data: { memberId: null, claimedAt: null, inviteCode: null },
      });
      await tx.courseEnrollment.updateMany({
        where: { viaSubscriptionId: seat.subscriptionId, memberId },
        data: { expiredDate: now },
      });
      // Counter + audit row in the same tx as the vacate: a vacate that is not
      // counted is exactly the loophole this exists to close.
      const sub = await tx.memberSubscription.update({
        where: { id: seat.subscriptionId },
        data: { seatChanges: { increment: 1 } },
        select: { seatChanges: true, plan: { select: { maxSeatChanges: true } } },
      });
      await tx.subscriptionSeatEvent.create({
        data: {
          subscriptionId: seat.subscriptionId,
          seatNo: seat.seatNo,
          kind: by.kind,
          memberId,
          actorId: by.actorId,
          seatChanges: sub.seatChanges,
        },
      });
      return sub;
    });
    return this.toSeatChanges(bumped);
  }

  private async assertSeatChangesLeft(sub: {
    seatChanges: number;
    plan: { maxSeatChanges: number | null };
  }): Promise<void> {
    const c = await this.toSeatChanges(sub);
    if (c.remaining <= 0) throw badRequest(ERROR_CODES.SUBSCRIPTION_SEAT_CHANGES_EXHAUSTED, c);
  }

  private async toSeatChanges(sub: {
    seatChanges: number;
    plan: { maxSeatChanges: number | null };
  }): Promise<SeatChanges> {
    const max =
      sub.plan.maxSeatChanges ??
      (await settingsService.getNumber(SETTING_KEYS.subscriptionMaxSeatChanges, MAX_SEAT_CHANGES_DEFAULT));
    return { used: sub.seatChanges, max, remaining: Math.max(0, max - sub.seatChanges) };
  }

  private async activeSubOrThrow(ownerId: string) {
    const sub = await prisma.memberSubscription.findFirst({
      where: { ownerId, status: 'ACTIVE' },
      include: { plan: { select: { seatCount: true, maxSeatChanges: true } } },
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
