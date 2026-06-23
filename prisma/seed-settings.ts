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
