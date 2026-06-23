import 'reflect-metadata';
import 'dotenv/config'; // load root .env first so DATABASE_URL etc. are set before prisma
import { logger } from '@bb/common/config/logger';
import { prisma } from '@bb/db';
import { affiliatePendingToBalance } from '@bb/domain/jobs/affiliate-pending-to-balance';
import { expirePendingPayments } from '@bb/domain/jobs/expire-pending-payments';

/**
 * Standalone scheduled-jobs entrypoint. Runs every registered job ONCE, then exits.
 *
 * The TRIGGER is intentionally decoupled from this file: PM2 `cron_restart`
 * (the `bb-cron` process) today, AWS EventBridge → ECS RunTask later — same
 * built binary, zero code change. Run it as its own process (never inside the
 * API): the API can scale to N instances, this stays a single scheduled run so
 * jobs fire exactly once.
 *
 * Each job is isolated so one failure doesn't skip the rest. Exit 0 = all
 * attempted (per-job errors logged); exit 1 = fatal (e.g. DB unreachable) so the
 * scheduler / alerting can react.
 */
const JOBS: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: 'affiliatePendingToBalance', run: () => affiliatePendingToBalance() },
  { name: 'expirePendingPayments', run: () => expirePendingPayments() },
];

async function main(): Promise<void> {
  const startedAt = Date.now();
  logger.info(
    { nodeEnv: process.env.NODE_ENV, jobs: JOBS.map((j) => j.name) },
    '[jobs-runner] start',
  );

  for (const job of JOBS) {
    try {
      const result = await job.run();
      logger.info({ job: job.name, result }, `[jobs-runner] ${job.name} ok`);
    } catch (err) {
      logger.error({ job: job.name, err }, `[jobs-runner] ${job.name} failed`);
    }
  }

  logger.info({ ms: Date.now() - startedAt }, '[jobs-runner] done');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, '[jobs-runner] fatal');
    await prisma.$disconnect();
    process.exit(1);
  });
