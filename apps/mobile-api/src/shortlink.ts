import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { clientIp } from '@bb/common/utils/client-ip.util';
import { trackingLinkService } from '@bb/domain/shop/tracking-link.service';

/**
 * Public shortlink redirect: `GET /s/:slug`.
 *
 * Mounted at the ROOT, not as an AppModule — modules are all mounted under
 * `/api` and this is not part of the JSON API surface. It follows the same
 * precedent as `/health` in `app.ts`.
 *
 * The host in front of it is a deployment detail: the ALB already takes extra
 * ACM certs by SNI, so pointing `link.<domain>` at this route is DNS plus a
 * certificate, with no change here.
 */

/**
 * Generous per-IP budget. Over budget the visitor is STILL redirected, just
 * without a counted click: a 429 rendered to someone who tapped a link in a
 * broadcast is a lost participant, and the throttle exists to bound writes, not
 * to police readers.
 */
const shortlinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: (_req, _res, next) => next(),
  skip: () => process.env.NODE_ENV === 'test',
});

export function shortlinkRouter(): Router {
  const router = Router();

  router.get('/:slug', shortlinkLimiter, async (req: Request, res: Response) => {
    const { url, linkId } = await trackingLinkService.resolve(String(req.params.slug ?? ''));

    // Fire-and-forget: the redirect must not wait on a counter, and a counter
    // that fails must not cost the visitor their click.
    if (linkId) {
      void trackingLinkService.recordClick(linkId, req.headers['user-agent']);
    }

    // 302, never 301. A permanent redirect is cached by the browser forever, so
    // the day someone fixes a link's voucher or product, everyone who already
    // clicked it keeps landing on the old target with no way for us to reach
    // them.
    res.redirect(302, url);
  });

  return router;
}
