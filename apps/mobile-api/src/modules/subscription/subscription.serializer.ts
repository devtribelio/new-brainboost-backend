import type {
  MemberSubscription,
  SubscriptionPlan,
  SubscriptionSeat,
} from '@prisma/client';
import type { PlanItemDto, SeatItemDto, SubscriptionMeDto } from './dto/subscription.dto';

type PlanWithProduct = SubscriptionPlan & {
  product: { id: string; title: string; price: number };
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
  };
}

type SeatWithMember = SubscriptionSeat & {
  member: { id: string; fullName: string | null } | null;
};

export function serializeSeat(seat: SeatWithMember, callerId: string): SeatItemDto {
  return {
    id: seat.id,
    seatNo: seat.seatNo,
    claimed: seat.memberId !== null,
    memberName: seat.member?.fullName ?? null,
    isMe: seat.memberId === callerId,
  };
}

export function serializeMe(
  callerId: string,
  sub: MemberSubscription & { plan: SubscriptionPlan },
  seats: SeatWithMember[],
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
  };
  if (role === 'owner') {
    base.seats = seats.map((s) => serializeSeat(s, callerId));
  } else {
    // A guest doesn't get the household roster — only their own seat.
    const mine = seats.find((s) => s.memberId === callerId);
    if (mine) base.seat = serializeSeat(mine, callerId);
  }
  return base;
}
