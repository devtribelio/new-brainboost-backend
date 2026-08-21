import 'reflect-metadata';
import 'dotenv/config'; // load root .env first so DATABASE_URL etc. are set before prisma
import { logger } from '@bb/common/config/logger';
import { prisma } from '@bb/db';
import { affiliatePendingToBalance } from '@bb/domain/jobs/affiliate-pending-to-balance';
import { refreshAffiliateLeaderboard } from '@bb/domain/jobs/affiliate-leaderboard';
import { executeApprovedDisbursements } from '@bb/domain/jobs/execute-approved-disbursements';
import { expirePendingPayments } from '@bb/domain/jobs/expire-pending-payments';
import { sweepOrphanUploads } from '@bb/domain/jobs/sweep-orphan-uploads';
import { subscriptionExpire } from '@bb/domain/jobs/subscription-expire';
import { subscriptionRenewalReminder } from '@bb/domain/jobs/subscription-renewal-reminder';
import { subscriptionSeatChoiceReminder } from '@bb/domain/jobs/subscription-seat-choice-reminder';
import { topicDigest } from '@bb/domain/jobs/topic-digest';

/**
 * Standalone scheduled-jobs entrypoint. Runs the registered jobs ONCE, then exits.
 *
 * The TRIGGER is intentionally decoupled from this file: PM2 `cron_restart`
 * (the `bb-cron*` processes) today, AWS EventBridge → ECS RunTask later — same
 * built binary, zero code change. Run it as its own process (never inside the
 * API): the API can scale to N instances, this stays a single scheduled run so
 * jobs fire exactly once.
 *
 * Argv = optional job-name filter, so the same binary can be scheduled at
 * different intervals per job (see ecosystem.config.js):
 *   node dist/jobs-runner.js                              → all jobs, in order
 *   node dist/jobs-runner.js executeApprovedDisbursements → only that job
 * An unknown job name exits 1 immediately — a typo'd cron entry must alert,
 * not silently run nothing.
 *
 * Each job is isolated so one failure doesn't skip the rest. Exit 0 = all
 * attempted (per-job errors logged); exit 1 = fatal (e.g. DB unreachable) so the
 * scheduler / alerting can react.
 */
const JOBS: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: 'affiliatePendingToBalance', run: () => affiliatePendingToBalance() },
  // When run together, AFTER pending-to-balance (a payout approved this tick sees
  // fresh balance state); sweeps backoffice-approved MANUAL payouts + crashed AUTO
  // rows to Xendit. Also scheduled solo on a faster tick (bb-cron-disburse).
  { name: 'executeApprovedDisbursements', run: () => executeApprovedDisbursements() },
  { name: 'expirePendingPayments', run: () => expirePendingPayments() },
  // Recompute the monthly affiliate leaderboard (current + unfrozen prev month).
  { name: 'refreshAffiliateLeaderboard', run: () => refreshAffiliateLeaderboard() },
  // Delete post uploads never referenced by a post (orphans past the TTL).
  { name: 'sweepOrphanUploads', run: () => sweepOrphanUploads() },
  // Expire BEFORE reminders: a sub past grace must not get a renewal reminder
  // in the same tick it dies.
  { name: 'subscriptionExpire', run: () => subscriptionExpire() },
  // ⚠️ emails require the bb-comms SubscriptionRenewalReminder template (BE-18
  // external dependency) — do not schedule this runner on prod before it ships.
  { name: 'subscriptionRenewalReminder', run: () => subscriptionRenewalReminder() },
  // In-app only (no comms template needed), so it is safe on prod from day one.
  // After the renewal reminder purely for log readability — the two are
  // independent, and a sub can legitimately receive both.
  { name: 'subscriptionSeatChoiceReminder', run: () => subscriptionSeatChoiceReminder() },
  // Safe on every hourly tick: the job no-ops unless the current WIB hour matches
  // `notification.digestHour`, which is what keeps the send time editable from the DB.
  { name: 'topicDigest', run: () => topicDigest() },
];

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !JOBS.some((j) => j.name === name));
if (unknown.length > 0) {
  logger.error(
    { unknown, known: JOBS.map((j) => j.name) },
    '[jobs-runner] unknown job name(s) in argv',
  );
  process.exit(1);
}
const jobsToRun = requested.length > 0 ? JOBS.filter((j) => requested.includes(j.name)) : JOBS;

async function main(): Promise<void> {
  const startedAt = Date.now();
  logger.info(
    { nodeEnv: process.env.NODE_ENV, jobs: jobsToRun.map((j) => j.name) },
    '[jobs-runner] start',
  );

  for (const job of jobsToRun) {
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
