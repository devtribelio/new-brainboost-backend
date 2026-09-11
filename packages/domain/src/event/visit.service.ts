import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { BOT_UA, trimOrNull } from '@bb/domain/shop/visit.rules';

export interface EventVisitInput {
  guestId?: string;
  /** Public slug from the URL. Unknown values are stored with a null eventId. */
  eventSlug?: string;
  memberId?: string | null;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  referer?: string;
  ipAddress?: string;
  userAgent?: string;
  clientEventId?: string;
}

export interface EventVisitResult {
  status: 'logged' | 'duplicate' | 'invalid' | 'error';
}

/**
 * Visits to an event page.
 *
 * A separate table from `shop_visits`, so an event's traffic can never surface
 * on the product Marketing pages — see the model comment for why isolation by
 * convention was not enough. The write RULES are shared (`shop/visit.rules`)
 * rather than copied: the bot filter and the trimming are the parts most likely
 * to drift apart if duplicated.
 */
export class EventVisitService {
  async logVisit(input: EventVisitInput): Promise<EventVisitResult> {
    try {
      const guestId = trimOrNull(input.guestId);
      if (!guestId) return { status: 'invalid' };

      // Dropped before the write, not filtered at read time: each unfurl carries
      // a fresh cookie-less guest id, so leaving them in inflates
      // `distinct guest_id` with no way to tell them apart afterwards.
      if (input.userAgent && BOT_UA.test(input.userAgent)) return { status: 'invalid' };

      const clientEventId = trimOrNull(input.clientEventId);
      if (clientEventId) {
        const existing = await prisma.eventVisit.findUnique({
          where: { clientEventId },
          select: { id: true },
        });
        if (existing) return { status: 'duplicate' };
      }

      // An unknown slug still gets a row: the UTM on it is real traffic, and
      // refusing it would throw away the only record that it happened.
      const slug = trimOrNull(input.eventSlug);
      const event = slug
        ? await prisma.event.findUnique({ where: { slug }, select: { id: true } })
        : null;

      await prisma.eventVisit.create({
        data: {
          guestId,
          memberId: input.memberId ?? null,
          eventId: event?.id ?? null,
          utmSource: trimOrNull(input.utmSource),
          utmMedium: trimOrNull(input.utmMedium),
          utmCampaign: trimOrNull(input.utmCampaign),
          utmContent: trimOrNull(input.utmContent),
          utmTerm: trimOrNull(input.utmTerm),
          referer: trimOrNull(input.referer),
          ipAddress: trimOrNull(input.ipAddress),
          userAgent: trimOrNull(input.userAgent),
          clientEventId,
        },
        select: { id: true },
      });

      return { status: 'logged' };
    } catch (err) {
      // Includes the P2002 lost by a concurrent double-send of the same
      // clientEventId — the row exists either way.
      logger.warn({ err }, 'event.visit.write_failed');
      return { status: 'error' };
    }
  }
}
