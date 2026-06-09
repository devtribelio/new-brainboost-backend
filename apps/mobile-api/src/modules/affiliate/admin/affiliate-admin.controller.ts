import type { Request, Response } from 'express';
import type { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { ok } from '@bb/common/utils/response.util';
import { BadRequestException, UnauthorizedException } from '@bb/common/exceptions';
import { assertUuid } from '@bb/common/utils/uuid.util';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@bb/common/openapi/decorators';
import { AffiliateDisbursementDto, KycDto } from '../dto/affiliate-response.dto';
import { RejectReasonDto } from './affiliate-admin.dto';

interface AdminRequest extends Request {
  admin?: { id: string; email: string; role: string };
}

/**
 * Admin (staff) JSON endpoints to approve/reject affiliate payouts + KYC.
 * Guarded by `adminBearerGuard` (admin JWT via Authorization: Bearer header).
 * These move REAL MONEY — approve fires the Xendit disbursement.
 */
@ApiTags('Affiliate Admin')
export class AffiliateAdminController {
  constructor(private readonly disbursementService: DisbursementService) {}

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve a PENDING payout → sends money via Xendit (status → PROCESSING)' })
  @ApiResponse({ status: 200, type: () => AffiliateDisbursementDto })
  approveDisbursement = async (req: AdminRequest, res: Response) => {
    if (!req.admin) throw new UnauthorizedException();
    const id = req.params.id;
    assertUuid(id);
    const row = await this.disbursementService.approveDisbursement(id, req.admin.id);
    return ok(res, row);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject a PENDING payout (status → REJECTED, frees the held balance)' })
  @ApiBody({ type: () => RejectReasonDto })
  @ApiResponse({ status: 200, type: () => AffiliateDisbursementDto })
  rejectDisbursement = async (req: AdminRequest, res: Response) => {
    if (!req.admin) throw new UnauthorizedException();
    const id = req.params.id;
    assertUuid(id);
    const { reason } = req.body as RejectReasonDto;
    if (!reason) throw new BadRequestException('reason required');
    const row = await this.disbursementService.rejectDisbursement(id, req.admin.id, reason);
    return ok(res, row);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve a member KYC (kycStatus → APPROVED)' })
  @ApiResponse({ status: 200, type: () => KycDto })
  approveKyc = async (req: AdminRequest, res: Response) => {
    if (!req.admin) throw new UnauthorizedException();
    const memberId = req.params.memberId;
    assertUuid(memberId);
    const kyc = await this.disbursementService.approveKyc(memberId, req.admin.id);
    return ok(res, kyc);
  };

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject a member KYC (kycStatus → REJECTED)' })
  @ApiBody({ type: () => RejectReasonDto })
  @ApiResponse({ status: 200, type: () => KycDto })
  rejectKyc = async (req: AdminRequest, res: Response) => {
    if (!req.admin) throw new UnauthorizedException();
    const memberId = req.params.memberId;
    assertUuid(memberId);
    const { reason } = req.body as RejectReasonDto;
    if (!reason) throw new BadRequestException('reason required');
    const kyc = await this.disbursementService.rejectKyc(memberId, req.admin.id, reason);
    return ok(res, kyc);
  };
}
