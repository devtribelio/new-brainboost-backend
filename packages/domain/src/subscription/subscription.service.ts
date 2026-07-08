import { Prisma, type MemberSubscription, type SubscriptionPlan } from '@prisma/client';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { BadRequestException } from '@bb/common/exceptions';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';

/** Fallback when the app_settings row is missing (seeded as 7). */
const GRACE_DAYS_DEFAULT = 7;

export type ActivationOutcome = 'initial' | 'renewal' | 'plan_change' | 'noop';

export interface ActivationResult {
  outcome: ActivationOutcome;
  /** null when outcome='noop'. */
  subscription: MemberSubscription | null;
  /** The plan involved — null only on a 'no-plan' noop. Saves emitters a query. */
  plan: SubscriptionPlan | null;
  /** Why a noop happened: product has no plan, or the transaction was already processed. */
  noopReason?: 'no-plan' | 'duplicate-transaction';
}

export interface ActivateFromPaymentInput {
  ownerId: string;
  productId: string;
  /** CommerceTransaction.id — the idempotency key (one activation per order). */
  transactionId: string;
  /** Payment channel: 'xendit' | 'revenuecat' (grants don't go through here). */
  source: string;
  /** RC original_transaction_id — binds the sub to the store subscription. */
  providerRef?: string | null;
  /**
   * Authoritative expiry from the provider (RC expiration_at_ms). When present it
   * ALWAYS wins over the locally computed `base + periodMonths` — RC already
   * accounts for store-side grace/billing retry.
   */
  providerExpiresAt?: Date | null;
}

export interface GrantResult {
  outcome: 'created' | 'extended';
  subscription: MemberSubscription;
}

/** Shared shape the initial/renew/change helpers consume — payment and grant paths. */
interface ActivationMeta {
  source: string;
  providerRef?: string | null;
  /** null/undefined for grants (no commerce transaction). */
  transactionId?: string | null;
  providerExpiresAt?: Date | null;
  /** Period override in months (grant campaigns); defaults to plan.periodMonths. */
  months?: number;
}

/**
 * Owner-side subscription state machine (PRD BE-03/BE-04). One activation per
 * commerce transaction, enforced by the `subscription_activations` ledger: the
 * unique `transaction_id` insert is the LAST write of the transaction, so a
 * redelivered webhook (Xendit retry / RC re-emit) rolls the whole thing back via
 * P2002 and becomes a no-op — expiry is never double-extended. Grants write a
 * ledger row with transactionId NULL (exempt from the partial unique): grant
 * idempotency is the calling script's job (BE-20 skips members who already have
 * a sub/seat).
 *
 * Event emission is intentionally NOT here — BE-07 wires the caller (commerce
 * listener) to emit subscription.* events AFTER this commits, based on `outcome`.
 */
export class SubscriptionService {
  async activateFromPayment(input: ActivateFromPaymentInput): Promise<ActivationResult> {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { productId: input.productId } });
    if (!plan) return { outcome: 'noop', subscription: null, plan: null, noopReason: 'no-plan' };

    const graceDays = await this.getGraceDays();

    // Retry once: two DIFFERENT first-time transactions racing on
    // uniq_active_sub_per_owner — the loser re-runs and lands on the renewal branch.
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(async (tx) => {
          const existing = await tx.memberSubscription.findFirst({
            where: { ownerId: input.ownerId, status: 'ACTIVE' },
          });

          let outcome: ActivationOutcome;
          let sub: MemberSubscription;
          if (!existing) {
            outcome = 'initial';
            sub = await this.createInitial(tx, input.ownerId, plan, graceDays, input);
          } else if (existing.planId === plan.id) {
            outcome = 'renewal';
            sub = await this.renew(tx, existing, plan.periodMonths, graceDays, input);
          } else {
            outcome = 'plan_change';
            sub = await this.changePlan(tx, existing, plan, graceDays, input);
          }

          // Idempotency gate — LAST write on purpose (see class doc).
          await tx.subscriptionActivation.create({
            data: {
              subscriptionId: sub.id,
              kind: outcome,
              source: input.source,
              transactionId: input.transactionId,
              providerRef: input.providerRef ?? null,
              previousExpiresAt: existing?.expiresAt ?? null,
              newExpiresAt: sub.expiresAt,
            },
          });

          return { outcome, subscription: sub, plan };
        });
      } catch (e) {
        if (isUniqueViolation(e, 'transaction_id')) {
          logger.info(
            { transactionId: input.transactionId },
            '[subscription] duplicate activation — no-op',
          );
          return { outcome: 'noop', subscription: null, plan, noopReason: 'duplicate-transaction' };
        }
        if (isUniqueViolation(e, 'owner_id') && attempt === 0) {
          logger.warn(
            { ownerId: input.ownerId },
            '[subscription] lost initial-activation race — retrying as renewal',
          );
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * Grant a subscription with no payment (BE-04): upgrade-claim campaign
   * (historic buyers > 2jt → 1 year Solo) and CS cases. Behaves identically to a
   * paid sub. Same plan ACTIVE → extend; different plan → reject (grants never
   * silently switch a member's tier).
   */
  async grant(memberId: string, planCode: string, months?: number): Promise<GrantResult> {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { code: planCode } });
    if (!plan) throw new BadRequestException(`Unknown subscription plan code: ${planCode}`);
    const graceDays = await this.getGraceDays();
    const meta: ActivationMeta = { source: 'granted', months };

    return prisma.$transaction(async (tx) => {
      const existing = await tx.memberSubscription.findFirst({
        where: { ownerId: memberId, status: 'ACTIVE' },
      });
      if (existing && existing.planId !== plan.id) {
        throw new BadRequestException(
          'Member already has an ACTIVE subscription on a different plan — grant rejected',
        );
      }

      const sub = existing
        ? await this.renew(tx, existing, plan.periodMonths, graceDays, meta)
        : await this.createInitial(tx, memberId, plan, graceDays, meta);

      await tx.subscriptionActivation.create({
        data: {
          subscriptionId: sub.id,
          kind: 'grant',
          source: 'granted',
          transactionId: null,
          previousExpiresAt: existing?.expiresAt ?? null,
          newExpiresAt: sub.expiresAt,
        },
      });

      return { outcome: existing ? 'extended' : 'created', subscription: sub } as GrantResult;
    });
  }

  /**
   * Refund revoke (PRD BE-08): resolve the sub via the activation ledger and
   * kill it NOW — refund is the one flow that cuts access immediately (unlike
   * cancel-intent). Idempotent: only an ACTIVE sub flips; a second refund (or a
   * refund after expiry) returns null. Seats are left as-is — the zombie-seat
   * release in createInitial/claimSeat recycles them when their members move on.
   */
  async revokeByTransactionId(transactionId: string): Promise<MemberSubscription | null> {
    const activation = await prisma.subscriptionActivation.findFirst({
      where: { transactionId },
      select: { subscriptionId: true },
    });
    if (!activation) return null;

    return prisma.$transaction(async (tx) => {
      const flipped = await tx.memberSubscription.updateMany({
        where: { id: activation.subscriptionId, status: 'ACTIVE' },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });
      if (flipped.count === 0) return null;
      await this.bumpLazyEnrollments(tx, activation.subscriptionId, new Date()); // access off now
      return tx.memberSubscription.findUniqueOrThrow({
        where: { id: activation.subscriptionId },
      });
    });
  }

  /**
   * RC EXPIRATION (PRD BE-12): the store says the entitlement is over (its grace
   * included) — flip ACTIVE → EXPIRED now. If our local expiry was still in the
   * future (clock skew / store-side early termination), pull it and the lazy
   * enrollments back to now so access dies with the status. Idempotent: returns
   * null unless an ACTIVE sub with this providerRef existed.
   */
  async expireByProviderRef(
    providerRef: string,
  ): Promise<(MemberSubscription & { plan: SubscriptionPlan }) | null> {
    return prisma.$transaction(async (tx) => {
      const sub = await tx.memberSubscription.findFirst({
        where: { providerRef, status: 'ACTIVE' },
      });
      if (!sub) return null;

      const now = new Date();
      const expiresAt = sub.expiresAt < now ? sub.expiresAt : now;
      const updated = await tx.memberSubscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED', expiresAt, graceUntil: expiresAt },
        include: { plan: true },
      });
      if (sub.expiresAt > now) await this.bumpLazyEnrollments(tx, sub.id, now);
      return updated;
    });
  }

  /**
   * RC CANCELLATION with UNSUBSCRIBE/BILLING_ERROR (PRD BE-12): cancel-INTENT
   * only — auto-renew is off but access continues to expiry. No revoke, no
   * commission void (that's the refund path). Idempotent: a second event on an
   * already-intent sub returns null so no duplicate subscription.canceled fires.
   */
  async cancelIntentByProviderRef(
    providerRef: string,
  ): Promise<(MemberSubscription & { plan: SubscriptionPlan }) | null> {
    const sub = await prisma.memberSubscription.findFirst({
      where: { providerRef, status: 'ACTIVE', canceledAt: null },
    });
    if (!sub) return null;
    return prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { canceledAt: new Date() },
      include: { plan: true },
    });
  }

  /**
   * Web cancel (PRD BE-19): cancel-INTENT on the caller's own ACTIVE sub —
   * access continues to expiry; a repurchase clears it. RC-sourced subs are
   * rejected: auto-renew for IAP can only be turned off in the store, and
   * pretending otherwise would leave the member still being charged.
   * Idempotent: an already-canceled intent returns changed=false (caller skips
   * the event).
   */
  async cancelIntentByOwner(ownerId: string): Promise<{
    subscription: MemberSubscription & { plan: SubscriptionPlan };
    changed: boolean;
  }> {
    const sub = await prisma.memberSubscription.findFirst({
      where: { ownerId, status: 'ACTIVE' },
      include: { plan: true },
    });
    if (!sub) throw new BadRequestException('Tidak ada subscription aktif');
    if (sub.source === 'revenuecat') {
      throw new BadRequestException(
        'Langganan kamu dikelola App Store / Play Store — matikan perpanjangan otomatis dari pengaturan langganan di store',
      );
    }
    if (sub.canceledAt) return { subscription: sub, changed: false };

    const updated = await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { canceledAt: new Date() },
      include: { plan: true },
    });
    return { subscription: updated, changed: true };
  }

  // --- branch: first activation -------------------------------------------------

  private async createInitial(
    tx: Prisma.TransactionClient,
    ownerId: string,
    plan: { id: string; periodMonths: number; seatCount: number },
    graceDays: number,
    meta: ActivationMeta,
  ): Promise<MemberSubscription> {
    const expiresAt =
      meta.providerExpiresAt ?? addMonths(new Date(), meta.months ?? plan.periodMonths);
    const sub = await tx.memberSubscription.create({
      data: {
        ownerId,
        planId: plan.id,
        status: 'ACTIVE',
        expiresAt,
        graceUntil: addDays(expiresAt, graceDays),
        source: meta.source,
        providerRef: meta.providerRef ?? null,
        latestTransactionId: meta.transactionId ?? null,
      },
    });

    // A seat on a DEAD sub (expired/canceled) is a zombie: it grants nothing but
    // still trips uniq_active_seat_per_member. Release the owner's zombie before
    // seating them — the common repurchase-after-expiry path.
    await tx.subscriptionSeat.updateMany({
      where: { memberId: ownerId, subscription: { NOT: { status: 'ACTIVE' } } },
      data: { memberId: null, claimedAt: null },
    });

    // Owner claims seat 1 — unless they still hold a seat on someone's ACTIVE sub
    // (RC path can't be blocked pre-payment; uniq_active_seat_per_member would fire).
    // The sub is still created with seat 1 left empty; a human (or leaveSeat) resolves it.
    const ownerSeatElsewhere = await tx.subscriptionSeat.findFirst({
      where: { memberId: ownerId },
    });
    if (ownerSeatElsewhere) {
      logger.warn(
        { ownerId, subscriptionId: sub.id, existingSeatId: ownerSeatElsewhere.id },
        '[subscription] owner already holds a seat elsewhere — seat 1 left empty',
      );
    }
    await tx.subscriptionSeat.createMany({
      data: Array.from({ length: plan.seatCount }, (_, i) => ({
        subscriptionId: sub.id,
        seatNo: i + 1,
        memberId: i === 0 && !ownerSeatElsewhere ? ownerId : null,
        claimedAt: i === 0 && !ownerSeatElsewhere ? new Date() : null,
      })),
    });
    return sub;
  }

  // --- branch: same-plan repurchase / grant extension -----------------------------

  private async renew(
    tx: Prisma.TransactionClient,
    sub: MemberSubscription,
    periodMonths: number,
    graceDays: number,
    meta: ActivationMeta,
  ): Promise<MemberSubscription> {
    const now = new Date();
    // Base = whichever is later: not-yet-expired subs extend from their expiry,
    // lapsed-but-still-ACTIVE (in grace) subs extend from now.
    const base = sub.expiresAt > now ? sub.expiresAt : now;
    const expiresAt = meta.providerExpiresAt ?? addMonths(base, meta.months ?? periodMonths);

    const updated = await tx.memberSubscription.update({
      where: { id: sub.id },
      data: {
        expiresAt,
        graceUntil: addDays(expiresAt, graceDays),
        canceledAt: null, // repurchase/grant revokes a pending cancel-intent
        source: meta.source,
        providerRef: meta.providerRef ?? sub.providerRef,
        latestTransactionId: meta.transactionId ?? sub.latestTransactionId,
      },
    });
    await this.bumpLazyEnrollments(tx, sub.id, expiresAt);
    return updated;
  }

  // --- branch: RC PRODUCT_CHANGE (web tier-change is blocked at checkout, BE-14) --

  private async changePlan(
    tx: Prisma.TransactionClient,
    sub: MemberSubscription,
    plan: { id: string; periodMonths: number; seatCount: number },
    graceDays: number,
    meta: ActivationMeta,
  ): Promise<MemberSubscription> {
    const now = new Date();
    const base = sub.expiresAt > now ? sub.expiresAt : now;
    const expiresAt = meta.providerExpiresAt ?? addMonths(base, meta.months ?? plan.periodMonths);

    const updated = await tx.memberSubscription.update({
      where: { id: sub.id },
      data: {
        planId: plan.id,
        expiresAt,
        graceUntil: addDays(expiresAt, graceDays),
        canceledAt: null,
        source: meta.source,
        providerRef: meta.providerRef ?? sub.providerRef,
        latestTransactionId: meta.transactionId ?? sub.latestTransactionId,
      },
    });

    // Seat reconciliation. Grow: append empty slots. Shrink: drop EMPTY slots from
    // the highest seatNo down — claimed seats are never dropped; if claimed seats
    // alone exceed the new count, keep them all (over-provisioned) and let a human
    // resolve. Seat 1 (owner) is claimed, so it always survives a shrink.
    const seats = await tx.subscriptionSeat.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { seatNo: 'desc' },
    });
    if (seats.length < plan.seatCount) {
      const maxNo = seats.length ? seats[0].seatNo : 0;
      await tx.subscriptionSeat.createMany({
        data: Array.from({ length: plan.seatCount - seats.length }, (_, i) => ({
          subscriptionId: sub.id,
          seatNo: maxNo + i + 1,
          memberId: null,
        })),
      });
    } else if (seats.length > plan.seatCount) {
      const removable = seats // desc order: drop from the top
        .filter((s) => s.memberId === null)
        .slice(0, seats.length - plan.seatCount);
      if (removable.length < seats.length - plan.seatCount) {
        logger.warn(
          { subscriptionId: sub.id, claimed: seats.filter((s) => s.memberId).length, target: plan.seatCount },
          '[subscription] plan change left more claimed seats than the new seatCount',
        );
      }
      if (removable.length) {
        await tx.subscriptionSeat.deleteMany({
          where: { id: { in: removable.map((s) => s.id) } },
        });
      }
    }

    await this.bumpLazyEnrollments(tx, sub.id, expiresAt);
    return updated;
  }

  // --- shared -------------------------------------------------------------------

  /** Renewal/plan-change moves every lazy enrollment of this sub to the new expiry. */
  private async bumpLazyEnrollments(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    expiresAt: Date,
  ): Promise<void> {
    await tx.courseEnrollment.updateMany({
      where: { viaSubscriptionId: subscriptionId },
      data: { expiredDate: expiresAt },
    });
  }

  private async getGraceDays(): Promise<number> {
    const raw = await settingsService.get(
      SETTING_KEYS.subscriptionGraceDays,
      String(GRACE_DAYS_DEFAULT),
    );
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : GRACE_DAYS_DEFAULT;
  }
}

function isUniqueViolation(e: unknown, field: string): boolean {
  // Prisma reports manually created partial indexes by COLUMN name, not constraint
  // name (P2002 meta.target = ['transaction_id'] for uniq_activation_tx). Within
  // this service's transaction each guarded column is unique to one constraint:
  // transaction_id → activation ledger, owner_id → one-ACTIVE-sub-per-owner.
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    (JSON.stringify(e.meta ?? {}) + e.message).includes(field)
  );
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}
