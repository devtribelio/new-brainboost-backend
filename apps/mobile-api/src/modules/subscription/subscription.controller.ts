import type { Request, Response } from 'express';
import { prisma } from '@bb/db';
import { ok } from '@bb/common/utils/response.util';
import { UnauthorizedException } from '@bb/common/exceptions';
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
  ClaimSeatDto,
  InviteResponseDto,
  PlanItemDto,
  SeatItemDto,
  SubscriptionMeDto,
} from './dto/subscription.dto';
import { serializeMe, serializePlan, serializeSeat } from './subscription.serializer';

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
    return ok(res, serializeMe(req.user.id, sub, seats));
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
