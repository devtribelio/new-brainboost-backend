import type { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  FIRST_PURCHASE_CAMPAIGN,
  issueForMember,
  loadLaunchAt,
  loadProgramConfig,
  type FirstPurchaseSource,
} from '../commerce/first-purchase-voucher.service';

/**
 * Issue a private voucher to every member whose FIRST paid course purchase happened
 * after the program was switched on.
 *
 * ONE issuing point, not two hooks. The rule "is this their first purchase?" has to
 * see both the new stack and the purchases arriving from Tribelio at once, and a hook
 * on either path knows only its own half. It also keeps business logic out of
 * `apps/resync-worker`, which depends on `@bb/common` alone and is deleted at
 * cutover. The price is that the message lands up to an hour after payment — which
 * for a "next purchase" voucher is an improvement, since it no longer competes with
 * the receipt email.
 *
 * The sweep is naturally idempotent: `vouchers` is unique on
 * `(owner_member_id, campaign)`, so re-running it, overlapping ticks, and a member
 * matched by both sources all collapse to one code.
 */

/** Re-scan this far behind the stored watermark. */
const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

/**
 * Ceiling on one tick's issues. The real protection against a mass mailing is that
 * `launchAt` cannot be moved backwards, but that lives in the backoffice UI, and this
 * is the backstop on the day somebody edits `app_settings` by hand.
 */
const MAX_ISSUES_PER_TICK = 500;

/**
 * A paid course purchase on the new stack.
 *
 * `amount` is the grand total AFTER voucher, so `> 0` drops exactly what P6 wants
 * dropped: free courses, 100 %-voucher orders, and TRIAL grants — all of which settle
 * as `amount: 0` rows that are nonetheless `PAID`.
 *
 * `product.course` rather than a product-type test: see `isCourseProduct`. This also
 * silently decides what to do about the third source nobody listed — IAP / Scalev /
 * Lynk.id orders land in this same table via `purchase-ingest.service`, and they
 * count, as they should: paying inside the app is paying. A subscription SKU with no
 * course row behind it does not, because it is not a course purchase.
 *
 * No `paidAt: { not: null }` guard: every writer of `status = 'PAID'` in this repo
 * sets `paid_at` in the same statement.
 */
const PAID_COURSE_ORDER = {
  status: 'PAID',
  amount: { gt: 0 },
  product: { course: { isNot: null } },
} satisfies Prisma.CommerceTransactionWhereInput;

/**
 * A paid course enrollment carried over from Tribelio.
 *
 * `expiredDate: null` excludes free trials (any dated grant is time-boxed), and
 * `isCanceled: false` excludes rows legacy removed — the resync maps the Cresenity
 * soft-delete `status = 0` onto a cancel. Both filters are load-bearing: without
 * them every expired legacy trial and every admin-removed enrollment reads as a
 * purchase.
 *
 * "Paid" is approximated by the course's CURRENT price. An enrollment granted by a
 * Tribelio admin on a paid course therefore counts, since the resync keeps no payment
 * status (it checks one, then discards it). Accepted: the cost is one discount to
 * somebody who did not pay, not money leaving.
 */
const LEGACY_PAID_ENROLLMENT = {
  legacyId: { not: null },
  expiredDate: null,
  isCanceled: false,
  course: { product: { price: { gt: 0 } } },
} satisfies Prisma.CourseEnrollmentWhereInput;

export interface FirstPurchaseVoucherOptions {
  /**
   * Restrict the whole sweep to one member. Without it a real send is untestable:
   * it would mail everyone who qualifies. A scoped run deliberately does NOT move
   * the watermark — doing so would tell the next full run that everybody else in
   * that window had already been handled.
   */
  memberId?: string;
  /** Report who would be issued, write nothing, move nothing. */
  dryRun?: boolean;
}

export interface FirstPurchaseVoucherResult {
  skipped?: 'disabled' | 'not-launched' | 'misconfigured';
  candidates: number;
  issued: number;
  duplicate: number;
  noContact: number;
  /** Over the per-tick cap; picked up next tick (the watermark is held back). */
  deferred: number;
  preview?: Array<{ memberId: string; source: FirstPurchaseSource; firstPurchaseAt: Date }>;
}

interface Candidate {
  memberId: string;
  source: FirstPurchaseSource;
  firstPurchaseAt: Date;
}

export async function firstPurchaseVoucher(
  now: Date = new Date(),
  opts: FirstPurchaseVoucherOptions = {},
): Promise<FirstPurchaseVoucherResult> {
  const empty: FirstPurchaseVoucherResult = {
    candidates: 0,
    issued: 0,
    duplicate: 0,
    noContact: 0,
    deferred: 0,
  };

  const enabled = await settingsService.getBoolean(
    SETTING_KEYS.firstPurchaseVoucherEnabled,
    false,
  );
  if (!enabled) return { ...empty, skipped: 'disabled' };

  // Two separate gates, both of which stop the job dead. `launchAt` is not merely
  // config: with it unset there is no cutoff at all, and the sweep would treat the
  // entire history as fair game.
  const launchAt = await loadLaunchAt();
  if (!launchAt) return { ...empty, skipped: 'not-launched' };

  const cfg = await loadProgramConfig();
  if (!cfg) {
    logger.warn('[first-purchase-voucher] program enabled but not fully configured — nothing issued');
    return { ...empty, skipped: 'misconfigured' };
  }

  const windowStart = await resolveWindowStart(launchAt);
  const candidates = await collectCandidates(windowStart, launchAt, opts.memberId);

  if (candidates.length === 0) {
    await checkpoint(now, opts, false);
    return empty;
  }

  if (opts.dryRun) {
    return {
      ...empty,
      candidates: candidates.length,
      preview: candidates,
    };
  }

  const batch = candidates.slice(0, MAX_ISSUES_PER_TICK);
  const deferred = candidates.length - batch.length;

  let issued = 0;
  let duplicate = 0;
  let noContact = 0;
  for (const c of batch) {
    try {
      const outcome = await issueForMember(c.memberId, c.source, cfg, now);
      if (outcome === 'issued') issued++;
      else if (outcome === 'duplicate') duplicate++;
      else {
        noContact++;
        // The only signal that somebody qualified and got nothing. Counted in the
        // job stats so the backoffice can show the number, and logged so the
        // individual accounts can be found.
        logger.info(
          { memberId: c.memberId, source: c.source },
          'first_purchase_voucher.skipped_no_contact',
        );
      }
    } catch (err) {
      // One member's failure must not abandon the rest of the sweep; the unique
      // guard makes the retry on the next tick free.
      logger.error({ err, memberId: c.memberId }, '[first-purchase-voucher] issue failed');
    }
  }

  await checkpoint(now, opts, deferred > 0);

  logger.info(
    { candidates: candidates.length, issued, duplicate, noContact, deferred, memberId: opts.memberId },
    '[first-purchase-voucher] sweep done',
  );
  return { candidates: candidates.length, issued, duplicate, noContact, deferred };
}

/**
 * Where this tick starts reading. The stored watermark is rewound by an hour because
 * a legacy enrollment can land in Postgres well after the moment it records: the
 * resync writes `date_start` from the legacy `created` timestamp, so a row synced at
 * 10:05 may be dated 09:30 and would sit behind an exact watermark forever.
 *
 * Never earlier than `launchAt` — reading further back cannot produce an eligible
 * member and only makes the scan wider.
 */
async function resolveWindowStart(launchAt: Date): Promise<Date> {
  const raw = (await settingsService.get(SETTING_KEYS.firstPurchaseVoucherLastSweepAt, '')).trim();
  if (raw === '') return launchAt;
  const last = new Date(raw);
  if (Number.isNaN(last.getTime())) return launchAt;
  const rewound = new Date(last.getTime() - WATERMARK_OVERLAP_MS);
  return rewound > launchAt ? rewound : launchAt;
}

/**
 * Advance the watermark — but only when this tick actually covered its window.
 *
 * Held back on a deferred batch (the members over the cap are still behind it), on a
 * dry run, and on a member-scoped run. Moving it in any of those cases skips real
 * buyers permanently, and nothing downstream would ever notice.
 */
async function checkpoint(
  now: Date,
  opts: FirstPurchaseVoucherOptions,
  deferred: boolean,
): Promise<void> {
  if (opts.dryRun || opts.memberId || deferred) return;
  await settingsService.set(SETTING_KEYS.firstPurchaseVoucherLastSweepAt, now.toISOString());
}

/**
 * Members whose first ever paid course purchase is at or after `launchAt`.
 *
 * Two passes, the shape the streak reminder uses: a narrow one over the sweep window
 * to find who to look at, then full history for those members only. The alternative —
 * walking every member's history every hour — is the query that gets slower every
 * month for no gain.
 */
async function collectCandidates(
  windowStart: Date,
  launchAt: Date,
  memberId?: string,
): Promise<Candidate[]> {
  const scope = memberId ? { memberId } : {};

  const [recentOrders, recentEnrollments] = await Promise.all([
    prisma.commerceTransaction.groupBy({
      by: ['memberId'],
      where: { ...PAID_COURSE_ORDER, ...scope, paidAt: { gte: windowStart } },
    }),
    prisma.courseEnrollment.groupBy({
      by: ['memberId'],
      where: { ...LEGACY_PAID_ENROLLMENT, ...scope, dateStart: { gte: windowStart } },
    }),
  ]);

  const memberIds = [
    ...new Set([...recentOrders, ...recentEnrollments].map((r) => r.memberId)),
  ];
  if (memberIds.length === 0) return [];

  const [orderHistory, enrollmentHistory, undated, alreadyHeld] = await Promise.all([
    prisma.commerceTransaction.groupBy({
      by: ['memberId'],
      where: { ...PAID_COURSE_ORDER, memberId: { in: memberIds } },
      _min: { paidAt: true },
    }),
    prisma.courseEnrollment.groupBy({
      by: ['memberId'],
      where: { ...LEGACY_PAID_ENROLLMENT, memberId: { in: memberIds }, dateStart: { not: null } },
      _min: { dateStart: true },
    }),
    // A legacy enrollment with no `date_start` (a MySQL zero-date that survived the
    // migration) is a purchase of UNKNOWN age, and `_min` would step over it — making
    // an old buyer look new. Undatable means undecidable, so skip the member; they
    // lose a voucher they might have earned, which is the cheaper error.
    prisma.courseEnrollment.findMany({
      where: { ...LEGACY_PAID_ENROLLMENT, memberId: { in: memberIds }, dateStart: null },
      select: { memberId: true },
      distinct: ['memberId'],
    }),
    prisma.voucher.findMany({
      where: { campaign: FIRST_PURCHASE_CAMPAIGN, ownerMemberId: { in: memberIds } },
      select: { ownerMemberId: true },
    }),
  ]);

  const firstOrder = new Map(orderHistory.map((r) => [r.memberId, r._min.paidAt]));
  const firstEnrollment = new Map(enrollmentHistory.map((r) => [r.memberId, r._min.dateStart]));
  const undecidable = new Set(undated.map((r) => r.memberId));
  const held = new Set(alreadyHeld.map((v) => v.ownerMemberId));

  const out: Candidate[] = [];
  for (const id of memberIds) {
    if (undecidable.has(id) || held.has(id)) continue;

    const app = firstOrder.get(id) ?? null;
    const legacy = firstEnrollment.get(id) ?? null;
    if (!app && !legacy) continue;

    // Ties go to LEGACY: a member holding both on the same instant came from
    // Tribelio, and the report is what the flag exists for.
    const source: FirstPurchaseSource = !app || (legacy && legacy <= app) ? 'LEGACY' : 'APP';
    const firstPurchaseAt = source === 'LEGACY' ? legacy! : app!;

    // The whole cutoff rule, in one comparison: their EARLIEST purchase must be at or
    // after launch. A member with any pre-launch purchase is never eligible, which is
    // the same thing as "no backfill to existing buyers" (P5).
    if (firstPurchaseAt < launchAt) continue;

    out.push({ memberId: id, source, firstPurchaseAt });
  }

  // Oldest first, so a capped tick issues in the order people bought.
  out.sort((a, b) => a.firstPurchaseAt.getTime() - b.firstPurchaseAt.getTime());
  return out;
}
