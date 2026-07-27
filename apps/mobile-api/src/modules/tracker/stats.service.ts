import { prisma } from '@bb/db';
import { MIN_SESSION_SEC, MIN_QUALIFY_SEC, WEEKLY_DAYS_TARGET } from './tracker.constants';
import { addDays, dayKey, toLocalDayWIB, weekStartMondayWIB } from './tracker.time';
import { computeStreak } from './tracker.streak';
import type { StatsHomeDto, WeeklyStreakEntryDto } from './dto/stats-home.dto';
import type { CourseStatsDto } from './dto/course-stats.dto';

const WEEK_MS = 7 * 86_400_000;

/** Sum the qualifying-day filter once. */
function qualifyingDays(groups: { localDay: Date; _sum: { listenedSec: number | null } }[]): Date[] {
  return groups
    .filter((g) => (g._sum.listenedSec ?? 0) >= MIN_QUALIFY_SEC)
    .map((g) => g.localDay);
}

/** Build the Mon→Sun (WIB) 7-entry streak strip from a set of qualifying day keys. */
function buildWeeklyStreak(qualifyingKeys: Set<string>, todayWIB: Date): WeeklyStreakEntryDto[] {
  const weekStart = weekStartMondayWIB(todayWIB);
  return Array.from({ length: 7 }, (_, i) => {
    const key = dayKey(addDays(weekStart, i));
    return { date: key, qualified: qualifyingKeys.has(key) };
  });
}

export class StatsService {
  /** All home-screen metrics, computed at read-time (spec §5.2 / §6). */
  async home(memberId: string): Promise<StatsHomeDto> {
    const todayWIB = toLocalDayWIB(new Date());

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
    const streakDays = computeStreak(qualifyingDays(dayGroups), todayWIB);

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
      day: computeStreak(qualifyingDays(byCourse.get(e.courseId) ?? []), todayWIB),
      target: e.course.programDays,
    }));

    // ---- Weekly recap (current WIB Mon..today window) -------------------
    const joinWeekStart = weekStartMondayWIB(toLocalDayWIB(member.createdAt));
    const currentWeekStart = weekStartMondayWIB(todayWIB);
    const weekNumber =
      Math.floor((currentWeekStart.getTime() - joinWeekStart.getTime()) / WEEK_MS) + 1;

    const weekGroups = dayGroups.filter((g) => g.localDay.getTime() >= currentWeekStart.getTime());
    const listenSec = weekGroups.reduce((s, g) => s + (g._sum.listenedSec ?? 0), 0);
    const daysActive = qualifyingDays(weekGroups).length;

    // ---- Weekly streak strip (Mon..Sun of the current WIB week) ---------
    // Always exactly 7 entries. A day qualifies when its total audio ≥
    // MIN_QUALIFY_SEC (global, all courses). Future days have no sessions, so
    // they fall out naturally as `qualified: false` — the client renders the
    // "future" vs "missed" distinction from `date` vs `today`.
    const weeklyStreak = buildWeeklyStreak(new Set(qualifyingDays(dayGroups).map(dayKey)), todayWIB);

    return {
      streakDays,
      sessionsPlayed,
      totalListenSec,
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
   * Per-course listening stats for the course detail screen (spec §2 / BB-114).
   * Pure audio for THIS course only — the §1 video-OR union does NOT apply here.
   * A never-listened course yields zeros / null (not a 404): the caller just has
   * no rows, so streak=0, totalListenSec=0, lastListenedAt=null.
   */
  async courseStats(memberId: string, courseId: string): Promise<CourseStatsDto> {
    const todayWIB = toLocalDayWIB(new Date());

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

    const qualifying = qualifyingDays(dayGroups);
    return {
      courseId,
      streak: computeStreak(qualifying, todayWIB),
      weeklyStreak: buildWeeklyStreak(new Set(qualifying.map(dayKey)), todayWIB),
      totalListenSec: totalAgg._sum.listenedSec ?? 0,
      lastListenedAt: last?.startedAt.toISOString() ?? null,
    };
  }
}
