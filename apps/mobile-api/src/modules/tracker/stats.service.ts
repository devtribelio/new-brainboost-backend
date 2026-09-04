import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  DAY_BOUNDARY_HOURS,
  GRACE_DAYS_DEFAULT,
  MIN_SESSION_SEC,
  MIN_QUALIFY_SEC,
  WEEKLY_DAYS_TARGET,
} from './tracker.constants';
import {
  addDays,
  dayKey,
  listeningDayEndsAt,
  monthBounds,
  monthKey,
  toListeningDayWIB,
  weekStartMondayWIB,
} from './tracker.time';
import { computeStreak, computeStreakState } from './tracker.streak';
import type { StatsHomeDto, WeeklyStreakEntryDto } from './dto/stats-home.dto';
import type { CourseStatsDto } from './dto/course-stats.dto';
import type { StreakCalendarDayDto, StreakCalendarDto } from './dto/streak-calendar.dto';

const WEEK_MS = 7 * 86_400_000;

/** Sum the qualifying-day filter once. */
function qualifyingDays(groups: { localDay: Date; _sum: { listenedSec: number | null } }[]): Date[] {
  return groups
    .filter((g) => (g._sum.listenedSec ?? 0) >= MIN_QUALIFY_SEC)
    .map((g) => g.localDay);
}

/**
 * The verdict for one day. The single place a date becomes a state, shared by the
 * weekly strip and the monthly calendar — two surfaces resolving this independently
 * is exactly how a dialog ends up arguing with the tile that opened it.
 *
 * Branch order is load-bearing. A day that qualified is `burning` even when it is
 * today (otherwise today would report `at_risk` after the member had already
 * listened), and `future` is decided before the today-check so tomorrow never reads
 * as a miss. `at_risk` is today-only and carries no claim about the streak's length —
 * a member on zero still gets it, meaning "today is still open".
 *
 * The calendar never asks about a day past `today`, so it never sees `future`.
 */
function dayState(
  date: string,
  todayKey: string,
  qualifyingKeys: Set<string>,
  forgivenKeys: Set<string>,
): string {
  // YYYY-MM-DD compares lexicographically, which is why the keys are strings.
  return qualifyingKeys.has(date)
    ? 'burning'
    : date > todayKey
      ? 'future'
      : date === todayKey
        ? 'at_risk'
        : forgivenKeys.has(date)
          ? 'dimmed'
          : 'none';
}

/**
 * Build the Mon→Sun (WIB) 7-entry streak strip, one `state` per day.
 *
 * The state is resolved HERE, not in the client: deciding "future" means comparing a
 * date against today, and a client that does its own date arithmetic against the
 * device clock is the exact failure this whole workstream removes. The server already
 * knows which listening day it is; it should say so. See `dayState` for the rules.
 */
function buildWeeklyStreak(
  qualifyingKeys: Set<string>,
  forgivenKeys: Set<string>,
  todayWIB: Date,
): WeeklyStreakEntryDto[] {
  const weekStart = weekStartMondayWIB(todayWIB);
  const todayKey = dayKey(todayWIB);

  return Array.from({ length: 7 }, (_, i) => {
    const date = dayKey(addDays(weekStart, i));
    return { date, state: dayState(date, todayKey, qualifyingKeys, forgivenKeys) };
  });
}

/**
 * Longest consecutive qualifying run inside one month's already-built day list.
 *
 * A `dimmed` day neither breaks the run nor counts toward it — the same treatment the
 * streak walk gives it, so the figure under the calendar cannot contradict the streak
 * number above it. `days` is contiguous by construction (dates are only ever omitted
 * at the two ends of the month), so walking it in order is enough.
 */
function longestRunIn(days: StreakCalendarDayDto[]): number {
  let run = 0;
  let best = 0;
  for (const d of days) {
    if (d.state === 'burning') {
      run += 1;
      if (run > best) best = run;
    } else if (d.state !== 'dimmed') {
      run = 0;
    }
  }
  return best;
}

export class StatsService {
  /**
   * All home-screen metrics, computed at read-time (spec §5.2 / §6).
   *
   * Every day here is a LISTENING day (04:00 WIB boundary), including the "today"
   * anchor: at 02:00 WIB the member is still inside yesterday's day, so the streak
   * must not look broken while they are literally listening.
   */
  async home(memberId: string): Promise<StatsHomeDto> {
    const todayWIB = toListeningDayWIB(new Date());

    const graceDays = await settingsService.getNumber(
      SETTING_KEYS.streakGraceDays,
      GRACE_DAYS_DEFAULT,
    );

    const [sessionsPlayed, totalAgg, dayGroups, enrollments, member] = await Promise.all([
      prisma.listeningSession.count({
        where: { memberId, listenedSec: { gte: MIN_SESSION_SEC } },
      }),
      prisma.listeningSession.aggregate({
        where: { memberId },
        _sum: { listenedSec: true },
      }),
      prisma.listeningSession.groupBy({
        by: ['localDay'],
        where: { memberId },
        _sum: { listenedSec: true },
      }),
      prisma.courseEnrollment.findMany({
        where: { memberId, isCanceled: false },
        select: {
          courseId: true,
          course: {
            select: { programDays: true, product: { select: { code: true, title: true } } },
          },
        },
      }),
      prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { createdAt: true },
      }),
    ]);

    const totalListenSec = totalAgg._sum.listenedSec ?? 0;

    // ---- Global streak --------------------------------------------------
    const streak = computeStreakState(qualifyingDays(dayGroups), todayWIB, graceDays);
    const streakDays = streak.days;

    // ---- Per-program challenges (one grouped query, then bucket) --------
    const courseIds = enrollments.map((e) => e.courseId);
    const perCourseDay = courseIds.length
      ? await prisma.listeningSession.groupBy({
          by: ['courseId', 'localDay'],
          where: { memberId, courseId: { in: courseIds } },
          _sum: { listenedSec: true },
        })
      : [];

    const byCourse = new Map<string, { localDay: Date; _sum: { listenedSec: number | null } }[]>();
    for (const row of perCourseDay) {
      if (!row.courseId) continue;
      const list = byCourse.get(row.courseId) ?? [];
      list.push({ localDay: row.localDay, _sum: row._sum });
      byCourse.set(row.courseId, list);
    }

    const challenges = enrollments.map((e) => ({
      courseId: e.courseId,
      code: e.course.product.code,
      title: e.course.product.title,
      day: computeStreak(qualifyingDays(byCourse.get(e.courseId) ?? []), todayWIB, graceDays),
      target: e.course.programDays,
    }));

    // ---- Weekly recap (current WIB Mon..today window) -------------------
    const joinWeekStart = weekStartMondayWIB(toListeningDayWIB(member.createdAt));
    const currentWeekStart = weekStartMondayWIB(todayWIB);
    const weekNumber =
      Math.floor((currentWeekStart.getTime() - joinWeekStart.getTime()) / WEEK_MS) + 1;

    const weekGroups = dayGroups.filter((g) => g.localDay.getTime() >= currentWeekStart.getTime());
    const listenSec = weekGroups.reduce((s, g) => s + (g._sum.listenedSec ?? 0), 0);
    const daysActive = qualifyingDays(weekGroups).length;

    // ---- Weekly streak strip (Mon..Sun of the current WIB week) ---------
    // Always exactly 7 entries. A day qualifies when its total audio ≥
    // MIN_QUALIFY_SEC (global, all courses). `forgivenDays` comes from the same
    // grace walk that produced the headline state, so a dimmed flame and a dimmed
    // circle can never disagree about which night was let off.
    const weeklyStreak = buildWeeklyStreak(
      new Set(qualifyingDays(dayGroups).map(dayKey)),
      new Set(streak.forgivenDays.map(dayKey)),
      todayWIB,
    );

    return {
      streakDays,
      sessionsPlayed,
      totalListenSec,
      streak: {
        days: streak.days,
        state: streak.state,
        // Only a dimmed streak has something to beat; the others would render a
        // countdown the member has no reason to act on.
        restoreDeadline: streak.state === 'dimmed' ? listeningDayEndsAt(todayWIB) : null,
        dayBoundaryHour: DAY_BOUNDARY_HOURS,
      },
      challenges,
      weeklyRecap: {
        weekNumber,
        daysActive,
        daysTarget: WEEKLY_DAYS_TARGET,
        streakDays,
        listenSec,
      },
      weeklyStreak,
      today: dayKey(todayWIB),
      qualifyThresholdSec: MIN_QUALIFY_SEC,
    };
  }

  /**
   * One month of the streak calendar (`docs/tracker-streak.md` §5.6).
   *
   * ONE unbounded `groupBy` answers every field. Scoping it to the month would not be
   * cheaper: `currentStreak` and `earliestMonth` need the whole history anyway, so a
   * month filter buys a second query rather than a smaller one. Indexed on
   * `(member_id, local_day)`; a member with two years of listening is ~700 rows.
   *
   * Dates are LISTENING days here exactly as everywhere else — a session started
   * 01:00 on the 5th belongs to the 4th. If the calendar and the streak number
   * bucketed differently, the dialog would become an argument against the tile that
   * opened it.
   */
  async streakCalendar(memberId: string, month?: string): Promise<StreakCalendarDto> {
    const todayWIB = toListeningDayWIB(new Date());
    const todayKey = dayKey(todayWIB);
    const targetMonth = month ?? monthKey(todayWIB);

    const graceDays = await settingsService.getNumber(
      SETTING_KEYS.streakGraceDays,
      GRACE_DAYS_DEFAULT,
    );

    const dayGroups = await prisma.listeningSession.groupBy({
      by: ['localDay'],
      where: { memberId },
      _sum: { listenedSec: true },
    });

    const qualifying = qualifyingDays(dayGroups);
    const streak = computeStreakState(qualifying, todayWIB, graceDays);
    const qualifyingKeys = new Set(qualifying.map(dayKey));
    const forgivenKeys = new Set(streak.forgivenDays.map(dayKey));

    // First TRACKED day, not first qualifying day: a five-minute first session is
    // still a day the member could have listened on, so it shows as `none` rather
    // than being omitted as "before you joined".
    const trackedKeys = dayGroups.map((g) => dayKey(g.localDay)).sort();
    const firstTrackedKey = trackedKeys[0] ?? null;

    // Only days the member could have listened on appear. Omitting covers both ends
    // with one rule — nothing before their first tracked day, nothing after today —
    // and is why `future` is never sent: the client draws an omitted date as a plain
    // number, so a member who joined in August opening June sees an empty calendar
    // rather than thirty missed days.
    const { start, end } = monthBounds(targetMonth);
    const days: StreakCalendarDayDto[] = [];
    for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
      const date = dayKey(d);
      if (!firstTrackedKey || date < firstTrackedKey || date > todayKey) continue;
      days.push({ date, state: dayState(date, todayKey, qualifyingKeys, forgivenKeys) });
    }

    return {
      month: targetMonth,
      today: todayKey,
      days,
      qualifiedDays: days.filter((d) => d.state === 'burning').length,
      longestRun: longestRunIn(days),
      // Member-level facts, returned whatever month was asked for: the client pages
      // months and decides from the month on screen whether an arrow is live, so a
      // March response missing `earliestMonth` would strand it with no way back.
      currentStreak: streak.days,
      earliestMonth: firstTrackedKey ? firstTrackedKey.slice(0, 7) : null,
      qualifyThresholdSec: MIN_QUALIFY_SEC,
      dayBoundaryHour: DAY_BOUNDARY_HOURS,
    };
  }

  /**
   * Per-course listening stats for the course detail screen (spec §2 / BB-114).
   * Pure audio for THIS course only — the §1 video-OR union does NOT apply here.
   * A never-listened course yields zeros / null (not a 404): the caller just has
   * no rows, so streak=0, totalListenSec=0, lastListenedAt=null.
   */
  async courseStats(memberId: string, courseId: string): Promise<CourseStatsDto> {
    const todayWIB = toListeningDayWIB(new Date());

    const [dayGroups, totalAgg, last] = await Promise.all([
      prisma.listeningSession.groupBy({
        by: ['localDay'],
        where: { memberId, courseId },
        _sum: { listenedSec: true },
      }),
      prisma.listeningSession.aggregate({
        where: { memberId, courseId },
        _sum: { listenedSec: true },
      }),
      prisma.listeningSession.findFirst({
        where: { memberId, courseId },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
    ]);

    // Same grace as the home screen. Without it this endpoint and `challenges[].day`
    // would report two different numbers for the same course on two screens.
    const graceDays = await settingsService.getNumber(
      SETTING_KEYS.streakGraceDays,
      GRACE_DAYS_DEFAULT,
    );
    const qualifying = qualifyingDays(dayGroups);
    const courseStreak = computeStreakState(qualifying, todayWIB, graceDays);
    return {
      courseId,
      streak: courseStreak.days,
      weeklyStreak: buildWeeklyStreak(
        new Set(qualifying.map(dayKey)),
        new Set(courseStreak.forgivenDays.map(dayKey)),
        todayWIB,
      ),
      totalListenSec: totalAgg._sum.listenedSec ?? 0,
      lastListenedAt: last?.startedAt.toISOString() ?? null,
    };
  }
}
