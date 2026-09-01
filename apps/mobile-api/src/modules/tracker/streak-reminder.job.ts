import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { NotificationProducer } from '@bb/domain/notification/notification.producer';
import { ActionLabel } from '@bb/domain/notification/action-labels';
import { GRACE_DAYS_DEFAULT, MIN_QUALIFY_SEC, WIB_OFFSET_MS } from './tracker.constants';
import { addDays, dayKey, toListeningDayWIB } from './tracker.time';
import { computeStreakState, type StreakState } from './tracker.streak';

/**
 * The two scheduled streak pushes (`docs/tracker-streak.md` §5.4).
 *
 * - `at_risk`, evening: the member kept a streak but has not listened tonight yet.
 * - `dimmed`, next morning: they missed a day and grace is still carrying it.
 *
 * Nothing is sent at 0 — a member whose streak is already gone gets no push, so the
 * feature never turns into a scold.
 *
 * The TRIGGER is the hourly `bb-cron` tick; this job decides whether the current
 * hour is one of its two, which is what keeps both send times editable from
 * `app_settings` with no redeploy and no PM2 change. Each send has its own on/off
 * switch (`streak.atRiskEnabled` / `streak.dimmedEnabled`) — they answer different
 * moments, so one must be silenceable without losing the other. It lives in the tracker module
 * rather than `@bb/domain/jobs` because the day/streak helpers are app-local and a
 * package must not import from an app.
 */

/** Below this the evening nudge is not worth a push — there is barely a streak to lose. */
export const MIN_STREAK_FOR_AT_RISK = 3;
export const AT_RISK_HOUR_DEFAULT = 21;
export const DIMMED_HOUR_DEFAULT = 9;
/** Members per push batch — bounds concurrent FCM calls on a big sweep. */
const BATCH_SIZE = 100;

export interface StreakReminderResult {
  skipped?: 'disabled' | 'wrong-hour';
  mode?: StreakState;
  candidates: number;
  pushed: number;
  /** Present on a dry run: what WOULD have been sent. */
  preview?: Array<{ memberId: string; days: number }>;
}

export interface StreakReminderOptions {
  /** Run regardless of the enabled flag and the configured hours — manual QA only. */
  force?: boolean;
  /** Which of the two sends to build. Required with `force`. */
  mode?: 'at_risk' | 'dimmed';
  /** Build the plan and return it without sending. */
  dryRun?: boolean;
  /**
   * Restrict the sweep to one member. Without it the job scans every member, which
   * makes a real send untestable — on production it would push to everybody, and in
   * a test it writes notifications for members other specs own.
   */
  memberId?: string;
}

/** Wall-clock hour in WIB — the gate that decides whether this tick is ours. */
export function wibHour(now: Date): number {
  return new Date(now.getTime() + WIB_OFFSET_MS).getUTCHours();
}

interface DayGroup {
  memberId: string;
  localDay: Date;
  _sum: { listenedSec: number | null };
}

const chunk = <T,>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function qualifyingDaysByMember(groups: DayGroup[]): Map<string, Date[]> {
  const byMember = new Map<string, Date[]>();
  for (const g of groups) {
    if ((g._sum.listenedSec ?? 0) < MIN_QUALIFY_SEC) continue;
    byMember.set(g.memberId, [...(byMember.get(g.memberId) ?? []), g.localDay]);
  }
  return byMember;
}

/**
 * Copy is split title/body: Android truncates a notification title at ~40 chars.
 *
 * No clock time is named. "sebelum jam 04.00" would be the literal deadline, but it
 * leaks an internal rule the member never agreed to and reads as a countdown at
 * 21:00 when seven hours remain. "hari ini" is worse — under a 04:00 boundary a
 * member listening at 01:00 is still inside the same day and would think they were
 * too late. "malam ini" is what actually happens: this is bedtime audio, and the
 * window is tonight either way.
 */
function copyFor(mode: StreakState, days: number): { title: string; body: string } {
  return mode === 'at_risk'
    ? {
        title: `Streak ${days} hari belum aman`,
        body: 'Dengarkan 10 menit malam ini untuk menjaganya.',
      }
    : {
        title: `Streak ${days} hari kamu padam`,
        body: 'Dengarkan 10 menit malam ini untuk menyalakannya lagi.',
      };
}

/**
 * Who is in each state right now, and how long their streak is.
 *
 * Two queries, not one per member. The first narrows to members whose recent days
 * can possibly put them in a reminder state; only those get their full history read
 * for the exact streak length, which is the number the copy quotes.
 */
export async function collectStreakReminders(
  mode: 'at_risk' | 'dimmed',
  graceDays: number,
  now: Date,
  onlyMemberId?: string,
): Promise<Array<{ memberId: string; days: number }>> {
  const today = toListeningDayWIB(now);
  const todayKey = dayKey(today);
  const yesterdayKey = dayKey(addDays(today, -1));

  const recent = await prisma.listeningSession.groupBy({
    by: ['memberId', 'localDay'],
    where: {
      localDay: { gte: addDays(today, -(graceDays + 1)) },
      ...(onlyMemberId ? { memberId: onlyMemberId } : {}),
    },
    _sum: { listenedSec: true },
  });

  const recentQualifying = qualifyingDaysByMember(recent);
  const candidateIds: string[] = [];

  for (const [memberId, days] of recentQualifying) {
    const keys = new Set(days.map(dayKey));
    if (keys.has(todayKey)) continue; // burning — nothing to warn about
    const qualifiedYesterday = keys.has(yesterdayKey);
    if (mode === 'at_risk' ? qualifiedYesterday : !qualifiedYesterday) candidateIds.push(memberId);
  }
  if (candidateIds.length === 0) return [];

  // Exact streak length needs the whole history — a member may be 200 days in.
  const full: DayGroup[] = [];
  for (const part of chunk(candidateIds, 500)) {
    const page = await prisma.listeningSession.groupBy({
      by: ['memberId', 'localDay'],
      where: { memberId: { in: part } },
      _sum: { listenedSec: true },
    });
    full.push(...page);
  }

  const plan: Array<{ memberId: string; days: number }> = [];
  for (const [memberId, days] of qualifyingDaysByMember(full)) {
    const streak = computeStreakState(days, today, graceDays);
    if (streak.state !== mode) continue;
    if (mode === 'at_risk' && streak.days < MIN_STREAK_FOR_AT_RISK) continue;
    plan.push({ memberId, days: streak.days });
  }
  return plan;
}

export async function streakReminder(
  now: Date = new Date(),
  opts: StreakReminderOptions = {},
): Promise<StreakReminderResult> {
  const empty: StreakReminderResult = { candidates: 0, pushed: 0 };

  const [atRiskEnabled, dimmedEnabled, graceDays, atRiskHour, dimmedHour] = await Promise.all([
    settingsService.getBoolean(SETTING_KEYS.streakAtRiskEnabled, false),
    settingsService.getBoolean(SETTING_KEYS.streakDimmedEnabled, false),
    settingsService.getNumber(SETTING_KEYS.streakGraceDays, GRACE_DAYS_DEFAULT),
    settingsService.getNumber(SETTING_KEYS.streakAtRiskHour, AT_RISK_HOUR_DEFAULT),
    settingsService.getNumber(SETTING_KEYS.streakDimmedHour, DIMMED_HOUR_DEFAULT),
  ]);

  let mode = opts.mode;
  if (!opts.force) {
    // Each send is gated by its OWN switch, checked only on its own hour: turning the
    // morning one off must not report the evening one as disabled, and vice versa.
    const hour = wibHour(now);
    if (hour === atRiskHour) {
      if (!atRiskEnabled) return { ...empty, mode: 'at_risk', skipped: 'disabled' };
      mode = 'at_risk';
    } else if (hour === dimmedHour) {
      if (!dimmedEnabled) return { ...empty, mode: 'dimmed', skipped: 'disabled' };
      mode = 'dimmed';
    } else {
      return { ...empty, skipped: 'wrong-hour' };
    }
  }
  if (!mode) throw new Error('streakReminder: opts.mode is required with force');

  // A dimmed member only exists while grace is carrying them, so with grace off the
  // morning send has nothing to say — skip the sweep instead of scanning for nobody.
  if (mode === 'dimmed' && graceDays <= 0) return { ...empty, mode };

  const plan = await collectStreakReminders(mode, graceDays, now, opts.memberId);
  if (plan.length === 0) return { ...empty, mode };
  if (opts.dryRun) return { mode, candidates: plan.length, pushed: 0, preview: plan };

  const producer = new NotificationProducer();
  const type = mode === 'at_risk' ? ActionLabel.StreakAtRisk : ActionLabel.StreakDimmed;
  const runDay = dayKey(toListeningDayWIB(now));
  let pushed = 0;

  for (const batch of chunk(plan, BATCH_SIZE)) {
    const sent = await Promise.all(
      batch.map((p) =>
        producer.createForMember({
          memberId: p.memberId,
          type,
          ...copyFor(mode, p.days),
          // One per member per listening day: a cron restart inside the hour must
          // not push the same nudge twice.
          dedupeKey: `${type}:${p.memberId}:${runDay}`,
          payload: { streakDays: p.days },
        }),
      ),
    );
    pushed += sent.filter(Boolean).length;
  }

  logger.info({ mode, candidates: plan.length, pushed }, '[streak-reminder] done');
  return { mode, candidates: plan.length, pushed };
}
