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
    key: 'disbursement.autoApproveMax',
    value: '1000000',
    description:
      'Max NET payout (IDR) eligible for auto-approval; anything above always goes MANUAL.',
  },
  {
    key: 'disbursement.fee',
    value: '5000',
    description: 'Flat platform fee (IDR) deducted from the gross payout (member receives gross - fee).',
  },
  {
    key: 'disbursement.minBalance',
    value: '55000',
    description:
      'Minimum withdrawable balance (IDR) required to request a payout (gross >= this).',
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
    description:
      'Comma-separated H-minus buckets for the renewal reminder job (email + push).',
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
