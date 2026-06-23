/* eslint-disable no-console */
/**
 * Issue (or rotate) a 3rd-party ingestion credential.
 *
 *   pnpm issue:credential <name> [--affiliate] [--refund]
 *   e.g. pnpm issue:credential revenuecat --affiliate
 *        pnpm issue:credential scalev                 (purchase only, no affiliate)
 *
 * Prints the plaintext key ONCE (only the hash is stored). Re-running rotates the key.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function hashKey(k: string): string {
  return crypto.createHash('sha256').update(k).digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const name = args[0];
  if (!name || name.startsWith('--')) {
    console.error('usage: pnpm issue:credential <name> [--affiliate] [--refund]');
    process.exit(1);
  }
  const triggersAffiliate = args.includes('--affiliate');
  const canIngestRefund = args.includes('--refund');
  const key = `bbk_${crypto.randomBytes(24).toString('hex')}`;

  await prisma.thirdPartyCredential.upsert({
    where: { name },
    create: { name, keyHash: hashKey(key), triggersAffiliate, canIngestRefund },
    update: { keyHash: hashKey(key), triggersAffiliate, canIngestRefund },
  });

  console.log(`credential "${name}" issued — triggersAffiliate=${triggersAffiliate} canIngestRefund=${canIngestRefund}`);
  console.log(`KEY (store securely, shown once): ${key}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
