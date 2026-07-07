import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { checkSqsConnection } from '@bb/common/mq/publisher';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2_000;
const MONITOR_INTERVAL_MS = 30_000;

type CheckResult = 'ok' | 'skipped';
type Target = { name: string; check: () => Promise<CheckResult> };

const TARGETS: Target[] = [
  {
    name: 'database',
    check: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return 'ok';
    },
  },
  { name: 'sqs', check: checkSqsConnection },
];

async function checkWithRetry({ name, check }: Target): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await check();
      if (result === 'skipped') {
        logger.warn(`[startup] ${name} check skipped (not configured)`);
      } else {
        logger.info(`[startup] ${name} connection ok`);
      }
      return;
    } catch (err) {
      if (attempt > MAX_RETRIES) {
        logger.error({ err }, `[startup] ${name} connection failed after ${MAX_RETRIES} retries`);
        throw err;
      }
      logger.warn(
        { err, attempt, maxRetries: MAX_RETRIES },
        `[startup] ${name} connection failed — retrying in ${RETRY_DELAY_MS}ms`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

/**
 * Fail-fast connectivity gate run before the process starts serving: database
 * (SELECT 1) then SQS (GetQueueAttributes; skipped when queue URLs are unset —
 * dev log-only mode). Each check retries up to MAX_RETRIES before throwing.
 */
export async function runStartupChecks(): Promise<void> {
  for (const target of TARGETS) {
    await checkWithRetry(target);
  }
}

/**
 * Periodic connectivity monitor for after boot. Prisma's pool and the SQS SDK
 * recover from an outage silently (new connection on the next query/request),
 * so without this probe a disconnect/reconnect never shows up in the logs.
 * Logs on state TRANSITIONS only — `connection lost` once when a target goes
 * down, `reconnected` once when it comes back — not on every tick. Assumes
 * runStartupChecks() passed, so every target starts as up.
 */
export function startConnectionMonitor(): void {
  const isUp = new Map(TARGETS.map((t) => [t.name, true]));
  let inFlight = false;

  const timer = setInterval(async () => {
    if (inFlight) return; // a slow/hanging probe from the previous tick — don't stack
    inFlight = true;
    try {
      for (const { name, check } of TARGETS) {
        try {
          if ((await check()) === 'skipped') continue;
          if (!isUp.get(name)) {
            logger.info(`[monitor] ${name} reconnected`);
            isUp.set(name, true);
          }
        } catch (err) {
          if (isUp.get(name)) {
            logger.error(
              { err },
              `[monitor] ${name} connection lost — probing every ${MONITOR_INTERVAL_MS}ms until it returns`,
            );
            isUp.set(name, false);
          }
        }
      }
    } finally {
      inFlight = false;
    }
  }, MONITOR_INTERVAL_MS);

  timer.unref(); // never keep the process alive just for the monitor
  logger.info({ intervalMs: MONITOR_INTERVAL_MS }, '[monitor] connection monitor started');
}
