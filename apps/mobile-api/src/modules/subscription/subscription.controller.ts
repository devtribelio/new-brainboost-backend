import type { Request, Response } from 'express';
import { prisma } from '@bb/db';
import { ok } from '@bb/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { subscriptionEvents } from '@bb/common/events/subscription-events';
import type { SubscriptionService } from '@bb/domain/subscription/subscription.service';
import type { SeatService } from '@bb/domain/subscription/seat.service';
import type { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBody,
} from '@bb/common/openapi/decorators';
import {
  CancelResponseDto,
  ChooseSeatsDto,
  ClaimSeatDto,
  DeclarePendingChangeDto,
  InviteResponseDto,
  PendingChangeDto,
  PlanItemDto,
  PlanQuoteDto,
  SeatItemDto,
  SubscriptionMeDto,
} from './dto/subscription.dto';
import {
  serializeMe,
  serializePendingChange,
  serializePlan,
  serializeSeat,
} from './subscription.serializer';

/**
 * HTTP surface of the subscription feature (PRD BE-19). Thin by design — all
 * behavior lives in the domain services (BE-03/05/06); this layer only maps
 * auth + params and serializes.
 */
@ApiTags('Subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly seatService: SeatService,
    private readonly entitlement: EntitlementService,
  ) {}

  @ApiOperation({ summary: 'Active subscription plans (paywall source)' })
  // isArray (not `[Dto]`) — the openapi registry only resolves the flag form;
  // the tuple form silently produced an empty response schema in Swagger.
  @ApiResponse({ status: 200, type: () => PlanItemDto, isArray: true })
  plans = async (_req: Request, res: Response) => {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true, product: { isActive: true } },
      orderBy: { sortOrder: 'asc' },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            price: true,
            iosProductId: true,
            androidProductId: true,
            iosPrice: true,
          },
        },
      },
    });
    return ok(res, plans.map(serializePlan));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'My subscription position: owner / seat member / none' })
  @ApiResponse({ status: 200, type: () => SubscriptionMeDto })
  me = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const sub = await this.entitlement.getActiveSubscriptionForMember(req.user.id);
    if (!sub) return ok(res, { role: 'none' });

    const seats = await prisma.subscriptionSeat.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { seatNo: 'asc' },
      include: { member: { select: { id: true, fullName: true } } },
    });

    // Owner-only: a seat member gets `pendingChange: null` from the serializer,
    // so there is nothing to look up for them either.
    let pending: PendingChangeDto | null = null;
    if (sub.pendingPlanId && sub.ownerId === req.user.id) {
      const pendingPlan = await prisma.subscriptionPlan.findUnique({
        where: { id: sub.pendingPlanId },
      });
      if (pendingPlan) {
        const claimed = seats.filter((s) => s.memberId !== null).length;
        pending = serializePendingChange(sub, pendingPlan, claimed);
      }
    }
    return ok(res, serializeMe(req.user.id, sub, seats, pending));
  };

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'What picking a plan would cost and whether checkout would accept it now',
  })
  @ApiResponse({ status: 200, type: () => PlanQuoteDto })
  quote = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const planCode = String(req.query.planCode ?? '');
    if (!planCode) throw new BadRequestException('planCode wajib diisi');
    return ok(res, await this.subscriptionService.quoteForPlan(req.user.id, planCode));
  };

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Schedule a downgrade at the end of the term (web/Android; upgrades go to checkout)',
  })
  @ApiBody({ type: () => DeclarePendingChangeDto })
  @ApiResponse({ status: 200, type: () => SubscriptionMeDto })
  declarePending = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const { planCode } = req.body as DeclarePendingChangeDto;
    const outcome = await this.subscriptionService.declarePendingChangeByOwner(
      req.user.id,
      planCode,
    );
    if (outcome.status === 'not-found') throw new UnauthorizedException();
    if (outcome.status === 'scheduled') {
      const sub = outcome.subscription;
      subscriptionEvents.emit('subscription.pending_change', {
        subscriptionId: sub.id,
        ownerId: sub.ownerId,
        planId: sub.plan.id,
        planCode: sub.plan.code,
        tier: sub.plan.tier,
        expiresAt: sub.expiresAt,
        source: sub.source,
        pendingPlanId: outcome.pendingPlan.id,
        pendingPlanCode: outcome.pendingPlan.code,
        pendingTier: outcome.pendingPlan.tier,
        pendingSeatCount: outcome.pendingPlan.seatCount,
        claimedSeats: outcome.claimedSeats,
        effectiveAt: sub.expiresAt,
      });
    }
    return this.me(req, res);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Drop a scheduled downgrade (store-managed subs must revert in the store)' })
  @ApiResponse({ status: 200, type: () => SubscriptionMeDto })
  cancelPending = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const sub = await this.entitlement.getActiveSubscriptionForMember(req.user.id);
    if (!sub || sub.ownerId !== req.user.id) throw new UnauthorizedException();
    if (sub.pendingSource === 'revenuecat') {
      throw new BadRequestException(
        'Perubahan paket ini dijadwalkan oleh App Store / Play Store — batalkan dari pengaturan langganan di store',
      );
    }
    await this.subscriptionService.clearPendingChange(sub.id);
    return this.me(req, res);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Pick which seats survive the scheduled downgrade (owner only)' })
  @ApiBody({ type: () => ChooseSeatsDto })
  @ApiResponse({ status: 200, type: () => SubscriptionMeDto })
  choosePendingSeats = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const { seatIds } = req.body as ChooseSeatsDto;
    await this.seatService.choosePendingSeats(req.user.id, seatIds);
    return this.me(req, res);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mint a fresh invite code on the first empty seat (owner only)' })
  @ApiResponse({ status: 200, type: () => InviteResponseDto })
  invite = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const result = await this.seatService.generateInvite(req.user.id);
    return ok(res, { inviteCode: result.inviteCode, seatNo: result.seatNo });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Claim a seat with an invite code' })
  @ApiBody({ type: () => ClaimSeatDto })
  @ApiResponse({ status: 200, type: () => SeatItemDto })
  claim = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const { code } = req.body as ClaimSeatDto;
    const seat = await this.seatService.claimSeat(req.user.id, code);
    return ok(res, serializeSeat({ ...seat, member: null }, req.user.id));
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Kick a member off a seat (owner only; not seat 1)' })
  @ApiResponse({ status: 200 })
  removeSeat = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    await this.seatService.removeSeat(req.user.id, req.params.seatId);
    return ok(res, { removed: true });
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Leave my seat (owner cannot leave — use cancel)' })
  @ApiResponse({ status: 200 })
  leaveSeat = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    await this.seatService.leaveSeat(req.user.id);
    return ok(res, { left: true });
  };

  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancel auto-renew intent (web subs only — IAP is managed in the store)',
  })
  @ApiResponse({ status: 200, type: () => CancelResponseDto })
  cancel = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) throw new UnauthorizedException();
    const { subscription, changed } = await this.subscriptionService.cancelIntentByOwner(
      req.user.id,
    );
    if (changed) {
      subscriptionEvents.emit('subscription.canceled', {
        subscriptionId: subscription.id,
        ownerId: subscription.ownerId,
        planId: subscription.plan.id,
        planCode: subscription.plan.code,
        tier: subscription.plan.tier,
        expiresAt: subscription.expiresAt,
        source: subscription.source,
        reason: 'user',
      });
    }
    return ok(res, { canceled: true, expiresAt: subscription.expiresAt });
  };
}
