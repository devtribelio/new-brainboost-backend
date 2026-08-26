import type {
  MemberSubscription,
  SubscriptionPlan,
  SubscriptionSeat,
} from '@prisma/client';
import type {
  PendingChangeDto,
  PlanItemDto,
  SeatItemDto,
  SubscriptionMeDto,
} from './dto/subscription.dto';

type PlanWithProduct = SubscriptionPlan & {
  product: {
    id: string;
    title: string;
    price: number;
    iosProductId: string | null;
    androidProductId: string | null;
    iosPrice: number | null;
  };
};

export function serializePlan(plan: PlanWithProduct): PlanItemDto {
  return {
    planCode: plan.code,
    tier: plan.tier,
    periodMonths: plan.periodMonths,
    seatCount: plan.seatCount,
    productId: plan.product.id,
    title: plan.product.title,
    price: plan.product.price,
    // Store SKUs for the RevenueCat/IAP purchase path (placeholder until the
    // real store products exist); iosPrice = gross IAP display price (marked
    // up to offset Apple's cut), null = same as web price.
    iosProductId: plan.product.iosProductId,
    androidProductId: plan.product.androidProductId,
    iosPrice: plan.product.iosPrice,
  };
}

type SeatWithMember = SubscriptionSeat & {
  member: { id: string; fullName: string | null } | null;
};

/**
 * `keepOnChange` is owner-only. To a seat member `false` is ambiguous — it is
 * both the untouched default and the value for someone the owner has decided to
 * drop — so exposing it invites them to conclude they are being removed when the
 * owner may simply not have opened the screen yet. They are told for certain at
 * the moment it lands, which is the only point where the answer is true.
 */
export function serializeSeat(
  seat: SeatWithMember,
  callerId: string,
  opts: { includeChoice: boolean } = { includeChoice: true },
): SeatItemDto {
  return {
    id: seat.id,
    seatNo: seat.seatNo,
    claimed: seat.memberId !== null,
    memberName: seat.member?.fullName ?? null,
    isMe: seat.memberId === callerId,
    ...(opts.includeChoice ? { keepOnChange: seat.pendingKeep } : {}),
  };
}

/**
 * A scheduled tier change. `mustEvict` is computed from today's occupancy, not
 * stored: members come and go between the declaration and the effective date, so
 * the answer is only true at the moment it is asked.
 */
export function serializePendingChange(
  sub: MemberSubscription,
  pendingPlan: SubscriptionPlan,
  claimedSeats: number,
): PendingChangeDto {
  return {
    planCode: pendingPlan.code,
    tier: pendingPlan.tier,
    seatCount: pendingPlan.seatCount,
    effectiveAt: sub.pendingEffectiveAt ?? sub.expiresAt,
    mustEvict: claimedSeats > pendingPlan.seatCount,
    // Apple/Google own their own schedule — offering our own revert button would
    // leave the store still switching the plan underneath us.
    canCancel: sub.pendingSource !== 'revenuecat',
    // `renewal.productId` keeps naming the CURRENT plan (the only one checkout
    // accepts while the term runs), so the pending product is carried here.
    productId: pendingPlan.productId,
  };
}

export function serializeMe(
  callerId: string,
  sub: MemberSubscription & { plan: SubscriptionPlan },
  seats: SeatWithMember[],
  pendingChange?: PendingChangeDto | null,
): SubscriptionMeDto {
  const role = sub.ownerId === callerId ? 'owner' : 'member';
  const base: SubscriptionMeDto = {
    role,
    status: sub.status,
    planCode: sub.plan.code,
    tier: sub.plan.tier,
    expiresAt: sub.expiresAt,
    graceUntil: sub.graceUntil,
    canceledAt: sub.canceledAt,
    source: sub.source,
    renewal: { productId: sub.plan.productId },
    pendingChange: pendingChange ?? null,
  };
  if (role === 'owner') {
    base.seats = seats.map((s) => serializeSeat(s, callerId));
  } else {
    // A guest doesn't get the household roster — only their own seat, and
    // without the owner's pending decisions (see serializeSeat). The scheduled
    // change itself is withheld too: a seat member can neither choose, cancel,
    // nor pay, so the only thing the information can do is worry them with a
    // conclusion that may turn out wrong.
    base.pendingChange = null;
    const mine = seats.find((s) => s.memberId === callerId);
    if (mine) base.seat = serializeSeat(mine, callerId, { includeChoice: false });
  }
  return base;
}
