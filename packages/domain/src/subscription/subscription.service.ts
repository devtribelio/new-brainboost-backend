import { Prisma, type MemberSubscription, type SubscriptionPlan } from '@prisma/client';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { BadRequestException } from '@bb/common/exceptions';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { isDowngrade, isUpgrade } from './tier';
import { computeProration } from './proration';

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
  /** Members who lost their seat because the new tier is smaller (plan_change only). */
  evictedMemberIds?: string[];
  /** The plan held BEFORE this activation — set on plan_change only. */
  previousPlanId?: string;
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

export type PendingChangeOutcome =
  | { status: 'not-found' }
  /** Already pointing at this plan, or nothing to revert. */
  | { status: 'unchanged'; subscription: MemberSubscription & { plan: SubscriptionPlan } }
  /** A pending change existed and was dropped. */
  | { status: 'reverted'; subscription: MemberSubscription & { plan: SubscriptionPlan } }
  | {
      status: 'scheduled';
      subscription: MemberSubscription & { plan: SubscriptionPlan };
      pendingPlan: SubscriptionPlan;
      claimedSeats: number;
    };

export interface PlanQuote {
  planCode: string;
  tier: string;
  seatCount: number;
  productId: string;
  action: 'purchase' | 'renewal' | 'upgrade' | 'downgrade';
  price: number;
  prorationCredit: number;
  amount: number;
  payableNow: boolean;
  payableReason: 'not_scheduled' | 'term_running' | 'seated_elsewhere' | null;
  remainingDays: number | null;
  effectiveAt: Date | null;
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
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { productId: input.productId },
      // Price comes along so a tier change can tell up from down — the two
      // anchor their new expiry differently (see changePlan).
      include: { product: { select: { price: true } } },
    });
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
          let evictedMemberIds: string[] = [];
          if (!existing) {
            outcome = 'initial';
            sub = await this.createInitial(tx, input.ownerId, plan, graceDays, input);
          } else if (existing.planId === plan.id) {
            outcome = 'renewal';
            sub = await this.renew(tx, existing, plan.periodMonths, graceDays, input);
          } else {
            outcome = 'plan_change';
            ({ sub, evictedMemberIds } = await this.changePlan(
              tx,
              existing,
              plan,
              graceDays,
              input,
            ));
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

          return {
            outcome,
            subscription: sub,
            plan,
            evictedMemberIds,
            previousPlanId: outcome === 'plan_change' ? existing?.planId : undefined,
          };
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
    opts: { keepGrace: boolean },
  ): Promise<(MemberSubscription & { plan: SubscriptionPlan }) | null> {
    const sub = await prisma.memberSubscription.findFirst({
      where: { providerRef, status: 'ACTIVE', canceledAt: null },
    });
    if (!sub) return null;
    return prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { canceledAt: new Date(), ...withdrawGrace(sub, opts.keepGrace) },
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
      data: { canceledAt: new Date(), ...withdrawGrace(sub, false) },
      include: { plan: true },
    });
    return { subscription: updated, changed: true };
  }

  /**
   * Record a SCHEDULED tier change (Approach B). Nothing about the current term
   * moves: the member keeps the plan, the seats and the expiry they paid for,
   * and the change lands when the renewal bills the new plan.
   *
   * Only downgrades ever get here — an upgrade is charged immediately (by Apple
   * on iOS, by us on web) and applies through the normal activation path. The
   * caller decides direction; this method just records what it is told.
   *
   * Re-declaring the SAME pending plan is a no-op that deliberately does NOT
   * reset the owner's seat selection: a redelivered webhook must not wipe a
   * choice they already made. Naming the plan they are already on cancels the
   * pending change instead — "downgrade to what I have" is a revert.
   */
  async schedulePendingChange(input: {
    providerRef?: string | null;
    ownerId?: string | null;
    planId: string;
    source: string;
  }): Promise<PendingChangeOutcome> {
    const sub = await this.findActiveSub(input);
    if (!sub) return { status: 'not-found' };

    if (sub.planId === input.planId) {
      const reverted = await this.clearPendingChange(sub.id);
      return { status: reverted ? 'reverted' : 'unchanged', subscription: sub };
    }
    if (sub.pendingPlanId === input.planId) {
      return { status: 'unchanged', subscription: sub };
    }

    const pendingPlan = await prisma.subscriptionPlan.findUnique({ where: { id: input.planId } });
    if (!pendingPlan) throw new BadRequestException('Paket tujuan tidak ditemukan');

    const [updated, claimedSeats] = await prisma.$transaction([
      prisma.memberSubscription.update({
        where: { id: sub.id },
        data: {
          pendingPlanId: pendingPlan.id,
          pendingEffectiveAt: sub.expiresAt,
          pendingSource: input.source,
          pendingDeclaredAt: new Date(),
        },
        include: { plan: true },
      }),
      // A new target means a new question — the previous answer may not even be
      // the right size any more.
      prisma.subscriptionSeat.updateMany({
        where: { subscriptionId: sub.id },
        data: { pendingKeep: false },
      }),
      prisma.subscriptionSeat.count({
        where: { subscriptionId: sub.id, memberId: { not: null } },
      }),
    ]).then(([u, , c]) => [u, c] as const);

    return {
      status: 'scheduled',
      subscription: updated,
      pendingPlan,
      claimedSeats: claimedSeats as number,
    };
  }

  /**
   * Web/Android entry point for declaring a tier change (PRD Approach B).
   *
   * Downgrades only. An upgrade is a purchase — it charges today and applies
   * today — so it belongs to checkout, not here; sending it down the pending
   * path would give the member a smaller bill AND a delayed benefit. A
   * store-managed subscription is refused outright: Apple owns its own schedule,
   * and a second schedule on our side would fight it.
   */
  async declarePendingChangeByOwner(
    ownerId: string,
    planCode: string,
  ): Promise<PendingChangeOutcome> {
    const sub = await prisma.memberSubscription.findFirst({
      where: { ownerId, status: 'ACTIVE' },
      include: { plan: { include: { product: { select: { price: true } } } } },
    });
    if (!sub) throw new BadRequestException('Tidak ada subscription aktif');
    if (sub.source === 'revenuecat') {
      throw new BadRequestException(
        'Langganan kamu dikelola App Store / Play Store — ubah paket dari pengaturan langganan di store',
      );
    }

    const target = await prisma.subscriptionPlan.findUnique({
      where: { code: planCode },
      include: { product: { select: { price: true } } },
    });
    if (!target || !target.isActive) throw new BadRequestException('Paket tidak ditemukan');

    const from = { seatCount: sub.plan.seatCount, price: sub.plan.product.price };
    const to = { seatCount: target.seatCount, price: target.product.price };
    if (target.id !== sub.planId && !isDowngrade(from, to)) {
      throw new BadRequestException(
        'Upgrade berlaku langsung — lanjutkan lewat checkout, bukan penjadwalan',
      );
    }

    return this.schedulePendingChange({ ownerId, planId: target.id, source: 'web' });
  }

  /**
   * Occupants other than the owner. Used by both expiry paths (sweep job and RC
   * EXPIRATION) to tell seat members why their access stopped — they lose it
   * exactly like the owner does but can do nothing about it, so they need their
   * own message.
   *
   * Safe to call after the status flip: expiry does not vacate seats (the rows
   * linger as "zombie" seats until the member claims one elsewhere), so the list
   * is the same before and after.
   */
  async seatHolderIds(subscriptionId: string, ownerId: string): Promise<string[]> {
    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId, memberId: { not: null }, NOT: { memberId: ownerId } },
      select: { memberId: true },
    });
    return seats.map((s) => s.memberId as string);
  }

  /**
   * What picking `planCode` would mean for this member right now: which action it
   * is, what it costs, and — crucially — whether checkout would actually accept
   * it today.
   *
   * Read-only on purpose. The only other way to learn an upgrade's price was to
   * POST a checkout, which WRITES: it creates a PENDING transaction and burns an
   * order number (the sequence counts the day's rows), so a member opening the
   * upgrade screen and backing out left litter behind and punched a hole in the
   * day's order codes.
   *
   * `payableNow` mirrors the checkout guard rather than restating it, so the two
   * cannot drift into telling the member different things. A downgrade is quoted
   * like any other plan — it has a real price (full, at renewal), and returning an
   * error for it would force the caller to rank tiers itself just to know which
   * plans it may ask about.
   */
  async quoteForPlan(memberId: string, planCode: string): Promise<PlanQuote> {
    const target = await prisma.subscriptionPlan.findUnique({
      where: { code: planCode },
      include: { product: { select: { id: true, price: true } } },
    });
    if (!target || !target.isActive) throw new BadRequestException('Paket tidak ditemukan');

    const base = {
      planCode: target.code,
      tier: target.tier,
      seatCount: target.seatCount,
      productId: target.product.id,
      price: target.product.price,
      prorationCredit: 0,
      amount: target.product.price,
      remainingDays: null as number | null,
      effectiveAt: null as Date | null,
    };

    const sub = await prisma.memberSubscription.findFirst({
      where: { ownerId: memberId, status: 'ACTIVE' },
      include: { plan: { include: { product: { select: { price: true } } } } },
    });

    if (!sub) {
      // Same guard checkout applies: holding a seat on someone else's live sub
      // has to be resolved before buying your own.
      const seatElsewhere = await prisma.subscriptionSeat.findFirst({
        where: {
          memberId,
          subscription: { status: 'ACTIVE', ownerId: { not: memberId } },
        },
        select: { id: true },
      });
      return {
        ...base,
        action: 'purchase',
        payableNow: !seatElsewhere,
        payableReason: seatElsewhere ? 'seated_elsewhere' : null,
      };
    }

    if (sub.planId === target.id) {
      // Early renewal is allowed — renew() anchors to the existing expiry, so
      // paying ahead stacks rather than throwing time away.
      return { ...base, action: 'renewal', payableNow: true, payableReason: null };
    }

    const from = { seatCount: sub.plan.seatCount, price: sub.plan.product.price };
    const to = { seatCount: target.seatCount, price: target.product.price };
    const now = new Date();

    if (isUpgrade(from, to)) {
      const p = computeProration({
        oldPrice: sub.plan.product.price,
        newPrice: target.product.price,
        expiresAt: sub.expiresAt,
        periodMonths: sub.plan.periodMonths,
        now,
      });
      return {
        ...base,
        action: 'upgrade',
        prorationCredit: p.credit,
        amount: p.charge,
        remainingDays: p.remainingDays,
        payableNow: true,
        payableReason: null,
      };
    }

    // Downgrade: full price, no credit, and only buyable once it has been
    // scheduled AND the paid term has actually run out.
    const scheduled = sub.pendingPlanId === target.id;
    const termOver = now >= sub.expiresAt;
    return {
      ...base,
      action: 'downgrade',
      effectiveAt: sub.expiresAt,
      payableNow: scheduled && termOver,
      payableReason: !scheduled ? 'not_scheduled' : termOver ? null : 'term_running',
    };
  }

  /** Drop a scheduled change. Returns false when there was nothing pending. */
  async clearPendingChange(subscriptionId: string): Promise<boolean> {
    const res = await prisma.memberSubscription.updateMany({
      where: { id: subscriptionId, pendingPlanId: { not: null } },
      data: {
        pendingPlanId: null,
        pendingEffectiveAt: null,
        pendingSource: null,
        pendingDeclaredAt: null,
      },
    });
    if (res.count) {
      await prisma.subscriptionSeat.updateMany({
        where: { subscriptionId },
        data: { pendingKeep: false },
      });
    }
    return res.count > 0;
  }

  private async findActiveSub(input: {
    providerRef?: string | null;
    ownerId?: string | null;
  }): Promise<(MemberSubscription & { plan: SubscriptionPlan }) | null> {
    if (input.providerRef) {
      return prisma.memberSubscription.findFirst({
        where: { providerRef: input.providerRef, status: 'ACTIVE' },
        include: { plan: true },
      });
    }
    if (input.ownerId) {
      return prisma.memberSubscription.findFirst({
        where: { ownerId: input.ownerId, status: 'ACTIVE' },
        include: { plan: true },
      });
    }
    return null;
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
    // Anchor to the CURRENT expiry, never to "now" (BB-79 amendment, 2026-07-10):
    // a renewal inside the grace window extends from the date the sub expired —
    // grace is breathing room to pay, not bonus time. Early renewals stack on
    // top of the remaining period as before. Renewal is only reachable while
    // ACTIVE (at worst in grace), so expiresAt is always the right anchor; a
    // repurchase past grace lands on the new-sub branch (anchored at now).
    const expiresAt =
      meta.providerExpiresAt ?? addMonths(sub.expiresAt, meta.months ?? periodMonths);

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
    plan: { id: string; periodMonths: number; seatCount: number; product: { price: number } },
    graceDays: number,
    meta: ActivationMeta,
  ): Promise<{ sub: MemberSubscription; evictedMemberIds: string[] }> {
    // Where the new term starts depends on the DIRECTION, and the two are not
    // interchangeable — this is the one place in the service where the renewal
    // anchor (BB-79) must NOT be reused.
    //
    // An UPGRADE was already paid for by discarding the old term: checkout
    // credits the unused portion back (`computeProration`) and charges the new
    // plan's full price on the understanding that the term restarts today.
    // Anchoring it to the old expiry hands that time back a second time — the
    // member is refunded for the remainder AND keeps it. Upgrading at the
    // midpoint of an annual plan bought 18 months of the bigger tier for 12,
    // and upgrading on day one bought nearly 24.
    //
    // A DOWNGRADE credits nothing (full price at renewal), so the old expiry is
    // the honest anchor there, exactly like a plain renewal.
    //
    // `providerExpiresAt` still wins outright: on the store path Apple does its
    // own proration and its expiry is the authority. That is also why this went
    // unnoticed — the comment here used to call the local math a fallback "since
    // RC sends providerExpiresAt in practice", forgetting that web and Android
    // never send it and therefore ALWAYS take this branch.
    const oldPlan = await tx.subscriptionPlan.findUnique({
      where: { id: sub.planId },
      include: { product: { select: { price: true } } },
    });
    const upgrading =
      oldPlan != null &&
      isUpgrade(
        { seatCount: oldPlan.seatCount, price: oldPlan.product.price },
        { seatCount: plan.seatCount, price: plan.product.price },
      );
    const anchor = upgrading ? new Date() : sub.expiresAt;
    const expiresAt =
      meta.providerExpiresAt ?? addMonths(anchor, meta.months ?? plan.periodMonths);

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
        // The scheduled change (if any) has now landed — whichever plan it named.
        // Clearing unconditionally is deliberate: a member who upgrades while a
        // downgrade is pending has changed their mind, and leaving the old
        // pointer armed would silently drop them back down at renewal.
        pendingPlanId: null,
        pendingEffectiveAt: null,
        pendingSource: null,
        pendingDeclaredAt: null,
      },
    });

    // Bump BEFORE reconciling: the bump moves every lazy enrollment on this sub
    // to the new expiry, evicted members included, so running it after would
    // hand back the access the eviction just cut.
    await this.bumpLazyEnrollments(tx, sub.id, expiresAt);
    const evictedMemberIds = await this.reconcileSeats(tx, sub.id, sub.ownerId, plan.seatCount);
    return { sub: updated, evictedMemberIds };
  }

  /**
   * Resize the seat array to the new plan.
   *
   * Growing (or shrinking with room to spare) only touches EMPTY slots. Shrinking
   * below the number of occupants is the destructive case: somebody must lose
   * access, and the choice is the owner's — seats they marked `pendingKeep` are
   * kept first, then the rest by seat number, with the owner (seat 1) always
   * safe. An owner who never chose gets the pure seat-number fallback, which is
   * the same rule, just with an empty selection.
   *
   * When an eviction happens the whole array is rewritten to seats 1..seatCount
   * so the occupants end up contiguous. Doing it in one clear-then-reassign pass
   * inside the transaction sidesteps both unique constraints
   * (`subscription_id, seat_no` and one-active-seat-per-member) that a
   * seat-by-seat shuffle would trip halfway through.
   */
  private async reconcileSeats(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    ownerId: string,
    seatCount: number,
  ): Promise<string[]> {
    const seats = await tx.subscriptionSeat.findMany({
      where: { subscriptionId },
      orderBy: { seatNo: 'asc' },
    });
    const claimed = seats.filter((s) => s.memberId !== null);

    if (claimed.length <= seatCount) {
      const removable = seats
        .filter((s) => s.memberId === null)
        .reverse() // drop from the highest seatNo down
        .slice(0, Math.max(seats.length - seatCount, 0));
      if (removable.length) {
        await tx.subscriptionSeat.deleteMany({
          where: { id: { in: removable.map((s) => s.id) } },
        });
      }
      const remaining = seats.length - removable.length;
      if (remaining < seatCount) {
        const taken = new Set(
          seats.filter((s) => !removable.includes(s)).map((s) => s.seatNo),
        );
        const fresh: number[] = [];
        for (let no = 1; fresh.length < seatCount - remaining; no++) {
          if (!taken.has(no)) fresh.push(no);
        }
        await tx.subscriptionSeat.createMany({
          data: fresh.map((seatNo) => ({ subscriptionId, seatNo, memberId: null })),
        });
      }
      return [];
    }

    const keepers = pickKeepers(claimed, seatCount, ownerId);
    const keptIds = new Set(keepers.map((s) => s.id));
    const evictedMemberIds = claimed
      .filter((s) => !keptIds.has(s.id))
      .map((s) => s.memberId as string);

    await tx.subscriptionSeat.updateMany({
      where: { subscriptionId },
      data: { memberId: null, claimedAt: null, inviteCode: null, pendingKeep: false },
    });
    await tx.subscriptionSeat.deleteMany({
      where: { subscriptionId, seatNo: { gt: seatCount } },
    });
    const survivingNos = new Set(
      seats.filter((s) => s.seatNo <= seatCount).map((s) => s.seatNo),
    );
    const missing = [];
    for (let no = 1; no <= seatCount; no++) if (!survivingNos.has(no)) missing.push(no);
    if (missing.length) {
      await tx.subscriptionSeat.createMany({
        data: missing.map((seatNo) => ({ subscriptionId, seatNo, memberId: null })),
      });
    }
    for (const [i, keeper] of keepers.entries()) {
      await tx.subscriptionSeat.update({
        where: { subscriptionId_seatNo: { subscriptionId, seatNo: i + 1 } },
        data: { memberId: keeper.memberId, claimedAt: keeper.claimedAt ?? new Date() },
      });
    }

    // Cut the evicted members' subscription-driven access immediately — same
    // rule as leaving a seat: retail rows (via_subscription_id NULL) untouched.
    await tx.courseEnrollment.updateMany({
      where: { viaSubscriptionId: subscriptionId, memberId: { in: evictedMemberIds } },
      data: { expiredDate: new Date() },
    });
    logger.info(
      { subscriptionId, seatCount, evicted: evictedMemberIds.length },
      '[subscription] plan change evicted seats over the new allowance',
    );
    return evictedMemberIds;
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

/**
 * Grace is time to FIX A PAYMENT, not a parting gift. `createInitial`/`renew`
 * arm it unconditionally (`expiresAt + graceDays`), which is right while the
 * subscription is expected to renew — but a member who deliberately quit is not
 * going to pay, so the extra week is just unbilled access. Pulling `graceUntil`
 * back to `expiresAt` keeps the entitlement predicate
 * (`coalesce(graceUntil, expiresAt) > now`) intact: access still runs to the end
 * of the paid term, it just stops there.
 *
 * `keepGrace` is true for a store BILLING_ERROR, where the cancel-intent means
 * "the card failed and the store is retrying" — that IS the case grace exists
 * for. A repurchase re-arms it via `renew`, so this is never a one-way door.
 */
function withdrawGrace(
  sub: MemberSubscription,
  keepGrace: boolean,
): { graceUntil?: Date } {
  if (keepGrace) return {};
  return { graceUntil: sub.expiresAt };
}

/**
 * Who survives a shrink: the owner, plus exactly the members the owner marked.
 * Nobody else — an unmarked seat is vacated even when the new plan still has
 * room for it.
 *
 * The obvious alternative, filling the leftover room by seat number, was tried
 * and dropped. It *guesses*, and it guesses silently: it cuts one member and
 * keeps another on the strength of a number that only accidentally tracks who
 * joined first — a seat vacated by a long-standing member and re-claimed by
 * someone new carries its low number to the newcomer, who then displaces people
 * who had been there for years. The owner would not necessarily notice for
 * weeks, by which point the cut member is long gone.
 *
 * Keeping nobody fails loudly instead. Everyone affected is told, the owner
 * hears about it immediately, and recovery is cheap and deliberate: the seats
 * are empty, an invite re-fills them, and a returning member keeps their
 * progress because the enrollment row is refreshed rather than recreated.
 * A silent wrong guess has no such undo.
 *
 * An owner who explicitly submits an empty selection lands here too, and that is
 * correct — "keep nobody" and "decide nothing" deserve the same outcome, which
 * is also why the two need not be distinguishable in the data.
 */
function pickKeepers<T extends { seatNo: number; memberId: string | null; pendingKeep: boolean }>(
  claimed: T[],
  seatCount: number,
  ownerId: string,
): T[] {
  const owner = claimed.filter((s) => s.memberId === ownerId);
  const marked = claimed
    .filter((s) => s.memberId !== ownerId && s.pendingKeep)
    .sort((a, b) => a.seatNo - b.seatNo);
  // Slice guards a selection that predates a shrink of the target plan; the
  // endpoint already caps it at declaration time.
  return [...owner, ...marked].slice(0, seatCount);
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
