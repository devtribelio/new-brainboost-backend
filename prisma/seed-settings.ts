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
    key: 'sales.alertEmail',
    value: '',
    description:
      'Comma-separated email address(es) that receive a SaleAlert email on every successful (non-subscription) sale. Empty = off.',
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
