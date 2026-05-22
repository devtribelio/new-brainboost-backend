import { Router } from 'express';
import { AffiliateController } from './affiliate.controller';
import { AffiliateProgramService } from './program.service';
import { AffiliatorService } from './affiliator.service';
import { EnrollmentService } from './enrollment.service';
import { VisitService } from './visit.service';
import { DisbursementService } from './disbursement.service';
import { authGuard, optionalAuthGuard } from '@/common/middlewares/auth.middleware';
import { bindRoute } from '@/common/openapi/route-binder';

export function affiliateRoutes(): Router {
  const router = Router();
  const ctrl = new AffiliateController(
    new AffiliateProgramService(),
    new AffiliatorService(),
    new EnrollmentService(),
    new VisitService(),
    new DisbursementService(),
  );

  // Affiliator profile
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me', handlerKey: 'getMe', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/me/mode', handlerKey: 'setMode', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/summary', handlerKey: 'getSummary', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/commissions', handlerKey: 'listMyCommissions', middlewares: [authGuard] });

  // Programs
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/programs', handlerKey: 'listPrograms' });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/programs/:code/enroll', handlerKey: 'enroll', middlewares: [authGuard] });

  // Visit + attribution (visit endpoint is public/optional-auth, attribution requires auth)
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/visits', handlerKey: 'logVisit', middlewares: [optionalAuthGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/attribution', handlerKey: 'logAttribution', middlewares: [authGuard] });

  // Disbursement / payout
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/disbursement', handlerKey: 'getDisbursementSummary', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/me/disbursement', handlerKey: 'requestDisbursement', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/disbursements', handlerKey: 'listDisbursements', middlewares: [authGuard] });

  return router;
}
