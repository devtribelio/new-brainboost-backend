import { Router } from 'express';
import { AffiliateController } from './affiliate.controller';
import { AffiliateProgramService } from '@bb/domain/affiliate/program.service';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';
import { EnrollmentService } from '@bb/domain/affiliate/enrollment.service';
import { VisitService } from '@bb/domain/affiliate/visit.service';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { authGuard, optionalAuthGuard } from '@bb/common/middlewares/auth.middleware';
import { validateDto } from '@bb/common/middlewares/validation.middleware';
import { bindRoute } from '@bb/common/openapi/route-binder';
import { RequestDisbursementDto, SetBankAccountDto, SubmitKycDto } from './dto/affiliate-request.dto';

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

  // Bank account (payout destination)
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/bank-account', handlerKey: 'getBankAccount', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'put', path: '/affiliate/me/bank-account', handlerKey: 'setBankAccount', middlewares: [authGuard, validateDto(SetBankAccountDto)] });

  // KYC (manual review gate for payouts)
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/kyc', handlerKey: 'getKyc', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/me/kyc', handlerKey: 'submitKyc', middlewares: [authGuard, validateDto(SubmitKycDto)] });
  // KYC via Didit — backend mints a verification session (token + URL); status flips via /api/webhook/didit
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/me/kyc/token', handlerKey: 'createKycToken', middlewares: [authGuard] });

  // Disbursement / payout
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/disbursement', handlerKey: 'getDisbursementSummary', middlewares: [authGuard] });
  bindRoute({ router, controller: ctrl, method: 'post', path: '/affiliate/me/disbursement', handlerKey: 'requestDisbursement', middlewares: [authGuard, validateDto(RequestDisbursementDto)] });
  bindRoute({ router, controller: ctrl, method: 'get', path: '/affiliate/me/disbursements', handlerKey: 'listDisbursements', middlewares: [authGuard] });

  return router;
}
