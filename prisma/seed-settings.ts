/* eslint-disable no-console */
/**
 * Seed default app_settings rows so they're visible/editable. Idempotent — re-running only
 * refreshes the description, NEVER overwrites a value an operator may have changed.
 *
 *   pnpm seed:settings
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SETTINGS: Array<{ key: string; value: string; description: string }> = [
  {
    key: 'affiliate.cookieDays',
    value: '365',
    description: 'Affiliate attribution cookie lifetime in days (legacy parity: 1 year).',
  },
  {
    key: 'affiliate.holdDays',
    value: '7',
    description: 'Days a commission stays PENDING before becoming withdrawable BALANCE.',
  },
  {
    key: 'affiliate.iapHoldDays',
    value: '35',
    description:
      'Days an IAP-channel commission stays PENDING before BALANCE (longer: covers store refund window).',
  },
  {
    key: 'banner.maxVersionAndroid',
    value: '',
    description:
      "Max Android app version (INCLUSIVE) that still sees banners on GET /api/data/banner, e.g. '3.3.0' = shown on 3.3.0 and below, hidden on 3.3.1+. Empty = gate off. Requires the client to send ?platform=android&version=; a build that sends neither always sees banners.",
  },
  {
    key: 'banner.maxVersionIos',
    value: '',
    description:
      "Max iOS app version (INCLUSIVE) that still sees banners on GET /api/data/banner, e.g. '3.3.0' = shown on 3.3.0 and below, hidden on 3.3.1+. Empty = gate off. Separate from Android because App Store review and Play rollout never land together.",
  },
  {
    key: 'disbursement.autoEnabled',
    value: 'false',
    description:
      "Kill-switch for the AUTO payout lane ('true' to enable). false = every payout goes through backoffice approval.",
  },
  {
    key: 'disbursement.autoApproveMax',
    value: '1000000',
    description:
      'Max NET payout (IDR) eligible for auto-approval; anything above always goes MANUAL.',
  },
  {
    key: 'disbursement.fee',
    value: '5000',
    description:
      'Flat platform fee (IDR) deducted from the gross payout (member receives gross - fee).',
  },
  {
    key: 'disbursement.minBalance',
    value: '55000',
    description: 'Minimum withdrawable balance (IDR) required to request a payout (gross >= this).',
  },
  {
    key: 'fx.usdIdr',
    value: '17800',
    description:
      'USD→IDR rate used to normalise foreign-storefront IAP purchases. Acts as the static floor of the resolution chain; promoted to top priority when fx.usdIdrPinned is true.',
  },
  {
    key: 'fx.usdIdrPinned',
    value: 'false',
    description:
      "Pin the USD→IDR rate to fx.usdIdr ('true' to enable), overriding the FX API and RevenueCat-derived rates. Use when the live rate is wrong or the providers are down.",
  },
  {
    key: 'kyc.minBalance',
    value: '55000',
    description:
      'Minimum withdrawable balance (IDR) required before a member may request KYC. 0 = gate off.',
  },
  {
    key: 'subscription.graceDays',
    value: '7',
    description:
      'Days of grace after a subscription expires before access is cut (graceUntil = expiresAt + this).',
  },
  {
    key: 'subscription.reminderDaysBefore',
    value: '7,3,1',
    description: 'Comma-separated H-minus buckets for the renewal reminder job (email + push).',
  },
  {
    key: 'notification.unopenedPushLimit',
    value: '0',
    description:
      'Max push sent to a member while they stay out of the app; further push is suppressed (the in-app notification row is still written). Resets when the member opens the app. 0 = gate off (counter still tracked). Ship value is 0 — raise to 3 only after confirming the app calls /member/info on resume, not just cold start.',
  },
  {
    key: 'notification.digestEnabled',
    value: 'false',
    description:
      "Nightly topic digest: one push per member summarising the topic posts they have not read. 'true' to enable. Ships disabled.",
  },
  {
    key: 'notification.digestHour',
    value: '21',
    description:
      'Hour of day (0-23, Asia/Jakarta) the topic digest is sent. The job runs on the hourly cron tick and only acts on this hour, so changing this value moves the send time with no redeploy.',
  },
  {
    key: 'streak.graceDays',
    value: '1',
    description:
      'Listening days a member may miss without the streak resetting to 0, counted back from today (so an old gap is never forgiven retroactively). 0 = strict, no grace. Changing this changes the streak number every shipped app build already displays, so treat it as a product switch, not a tuning knob.',
  },
  {
    key: 'streak.atRiskEnabled',
    value: 'false',
    description:
      "Evening push telling a member their streak is not safe yet. 'true' to enable. Ships disabled — a new outbound message class to the whole active base. Independent of streak.dimmedEnabled.",
  },
  {
    key: 'streak.dimmedEnabled',
    value: 'false',
    description:
      "Morning push telling a member their streak went dim and can still be revived today. 'true' to enable. Independent of streak.atRiskEnabled, and silent regardless while streak.graceDays = 0, since no member can be in the dimmed state then.",
  },
  {
    key: 'streak.atRiskHour',
    value: '21',
    description:
      'Hour (0-23, Asia/Jakarta) the "streak not safe yet" push fires. NOTE: at 21:00 most of the night\'s listening has not started (the histogram peaks at 23:00), so this hour may be too early to carry any signal — check what share of members who eventually qualify have already started by this hour before trusting it.',
  },
  {
    key: 'streak.dimmedHour',
    value: '9',
    description:
      'Hour (0-23, Asia/Jakarta) the "streak dimmed, revive it today" push fires, the morning after a missed day. Only ever has candidates while streak.graceDays > 0.',
  },
  {
    key: 'sales.alertEmail',
    value: '',
    description:
      'Comma-separated email address(es) that receive a SaleAlert email on every successful (non-subscription) sale. Empty = off.',
  },
  {
    key: 'affiliate.leaderboardTopN',
    value: '20',
    description:
      'How many rows GET /member/affiliate/leaderboard returns in `top`. The aggregate table always stores the FULL ranking — this only caps the read.',
  },
  {
    key: 'playlist.maxPerMember',
    value: '20',
    description:
      'Max playlists a member may own. -1 = unlimited, 0 = may not create any (0 is NOT unlimited). members.playlist_quota overrides this per member.',
  },
  {
    key: 'playlist.maxItems',
    value: '200',
    description: 'Max audio items in a single playlist.',
  },
  {
    key: 'playlist.interludeAssetId',
    value: '',
    description:
      'Bunny Stream guid of the global interlude clip played between playlist items. Empty = interlude disabled. Store the guid, never a URL.',
  },
  {
    key: 'playlist.requiresSubscription',
    value: 'true',
    description:
      "Kill-switch: 'true' = playlists are a subscriber-only feature (play + create). 'false' opens them to any member with content access.",
  },
  {
    key: 'upload.orphanTtlHours',
    value: '168',
    description:
      'Age (hours) after which an unreferenced `kind=post` upload is deleted by the sweep job. Generous by design: deletion is irreversible.',
  },
];

async function main() {
  for (const s of SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: s.key },
      create: s,
      update: { description: s.description }, // keep operator-set value; refresh description only
    });
    console.log(`seeded ${s.key}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
