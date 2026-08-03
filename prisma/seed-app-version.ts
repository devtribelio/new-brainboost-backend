/* eslint-disable no-console */
/**
 * Seed one app_version_configs row per platform so ops has something to edit.
 * Idempotent and INSERT-ONLY: re-running never touches a row an operator has changed —
 * an accidental re-seed must not silently reset a live force threshold.
 *
 *   pnpm seed:app-version
 *
 * Defaults are deliberately inert: force_below = NULL (force disabled). Raising it is a
 * manual, deliberate act — and only AFTER the store actually serves the newer build.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Current live version per platform. Bump via SQL/backoffice after a release, not here. */
const CONFIGS = [
  { platform: 'android', latestVersion: '3.2.3' },
  { platform: 'ios', latestVersion: '3.2.3' },
];

async function main() {
  for (const cfg of CONFIGS) {
    const existing = await prisma.appVersionConfig.findUnique({
      where: { platform: cfg.platform },
      select: { latestVersion: true, forceBelow: true },
    });
    if (existing) {
      console.log(
        `= ${cfg.platform}: kept (latestVersion=${existing.latestVersion}, forceBelow=${existing.forceBelow ?? 'null'})`,
      );
      continue;
    }
    await prisma.appVersionConfig.create({
      data: {
        platform: cfg.platform,
        latestVersion: cfg.latestVersion,
        forceBelow: null,
        storeUrl: null,
        softMessage: null,
        forceMessage: null,
      },
    });
    console.log(`+ ${cfg.platform}: latestVersion=${cfg.latestVersion}, force disabled`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
