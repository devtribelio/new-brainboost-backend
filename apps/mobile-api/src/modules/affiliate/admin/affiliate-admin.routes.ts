import { Router } from 'express';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { AffiliateAdminController } from './affiliate-admin.controller';
import { adminBearerGuard } from './admin-bearer.guard';
import { RejectReasonDto } from './affiliate-admin.dto';

export function affiliateAdminRoutes(): Router {
  const router = Router();
  const ctrl = new AffiliateAdminController(new DisbursementService());

  // Disbursement approve / reject
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/disbursements/:id/approve', handlerKey: 'approveDisbursement', middlewares: [adminBearerGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/disbursements/:id/reject', handlerKey: 'rejectDisbursement', middlewares: [adminBearerGuard, validateDto(RejectReasonDto)] });

  // KYC approve / reject
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/kyc/:memberId/approve', handlerKey: 'approveKyc', middlewares: [adminBearerGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/kyc/:memberId/reject', handlerKey: 'rejectKyc', middlewares: [adminBearerGuard, validateDto(RejectReasonDto)] });

  return router;
}
