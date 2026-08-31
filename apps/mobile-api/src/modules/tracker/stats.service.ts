import { prisma } from '@bb/db';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  DAY_BOUNDARY_HOURS,
  GRACE_DAYS_DEFAULT,
  MIN_SESSION_SEC,
  MIN_QUALIFY_SEC,
  WEEKLY_DAYS_TARGET,
} from './tracker.constants';
import { listeningDayEndsAt, toListeningDayWIB, weekStartMondayWIB } from './tracker.time';
import { computeStreak, computeStreakState } from './tracker.streak';
import type { StatsHomeDto } from './dto/stats-home.dto';

const WEEK_MS = 7 * 86_400_000;

/** Sum the qualifying-day filter once. */
function qualifyingDays(groups: { localDay: Date; _sum: { listenedSec: number | null } }[]): Date[] {
  return groups
    .filter((g) => (g._sum.listenedSec ?? 0) >= MIN_QUALIFY_SEC)
    .map((g) => g.localDay);
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
    };
  }
}
