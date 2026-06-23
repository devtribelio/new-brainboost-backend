import { prisma } from '@bb/db';
import { MIN_SESSION_SEC, MIN_QUALIFY_SEC, WEEKLY_DAYS_TARGET } from './tracker.constants';
import { toLocalDayWIB, weekStartMondayWIB } from './tracker.time';
import { computeStreak } from './tracker.streak';
import type { StatsHomeDto } from './dto/stats-home.dto';

const WEEK_MS = 7 * 86_400_000;

/** Sum the qualifying-day filter once. */
function qualifyingDays(groups: { localDay: Date; _sum: { listenedSec: number | null } }[]): Date[] {
  return groups
    .filter((g) => (g._sum.listenedSec ?? 0) >= MIN_QUALIFY_SEC)
    .map((g) => g.localDay);
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
    };
  }
}
