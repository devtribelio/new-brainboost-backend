import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';
import { addDays, dayKey, toLocalDayWIB, weekStartMondayWIB } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Noon WIB (05:00Z) of a UTC-midnight WIB day — always inside that WIB day. */
function noonWibOf(day: Date): Date {
  // Clamped to now. Noon WIB of TODAY is in the future for any run before midday, and
  // `TrackingService.record` rejects a `startedAt` more than MAX_CLOCK_SKEW_SEC ahead
  // — so without this the whole tracker suite is red every morning and green every
  // afternoon. Past days are unaffected; only today's noon can be ahead of the clock.
  const noon = day.getTime() + 5 * 3_600_000;
  return new Date(Math.min(noon, Date.now()));
}

describe('StatsService.courseStats — per-course listening stats (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();

  let memberId = '';
  let courseA = '';
  let courseB = '';
  let courseC = '';
  let productA = '';
  let productB = '';
  let productC = '';
  const courseNever = crypto.randomUUID(); // valid UUID, never listened

  const today = toLocalDayWIB(new Date());
  const weekStart = weekStartMondayWIB(today);
  const isMonday = today.getTime() === weekStart.getTime();

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `cstats-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    productA = (await prisma.product.create({ data: { type: 'course', title: 'Course A', code: `A-${uid()}` } })).id;
    productB = (await prisma.product.create({ data: { type: 'course', title: 'Course B', code: `B-${uid()}` } })).id;
    courseA = (await prisma.course.create({ data: { productId: productA, programDays: 30 } })).id;
    courseB = (await prisma.course.create({ data: { productId: productB, programDays: 30 } })).id;
    productC = (await prisma.product.create({ data: { type: 'course', title: 'Course C', code: `C-${uid()}` } })).id;
    courseC = (await prisma.course.create({ data: { productId: productC, programDays: 30 } })).id;

    // Course A: qualifying today (700s) + qualifying yesterday (700s) when in-week.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: courseA, startedAt: noonWibOf(today).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
    if (!isMonday) {
      await tracking.record(
        memberId,
        { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: courseA, startedAt: noonWibOf(addDays(today, -1)).toISOString(), listenedSec: 700, completed: true },
        'ios',
      );
    }
    // Course B: only a sub-threshold listen today (100s) — must NOT qualify.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: courseB, startedAt: noonWibOf(today).toISOString(), listenedSec: 100, completed: false },
      'ios',
    );

    // Course C: three short sittings on ONE day, 250+250+250 = 750s. No single
    // sitting reaches 10 minutes; together they pass. That is the whole rule.
    for (const _ of [1, 2, 3]) {
      await tracking.record(
        memberId,
        { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: courseC, startedAt: noonWibOf(today).toISOString(), listenedSec: 250, completed: false },
        'ios',
      );
    }
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.course.deleteMany({ where: { id: { in: [courseA, courseB, courseC] } } });
    await prisma.product.deleteMany({ where: { id: { in: [productA, productB, productC] } } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('isolates stats to the requested course (A ≠ B)', async () => {
    const a = await stats.courseStats(memberId, courseA);
    expect(a.courseId).toBe(courseA);
    expect(a.daysListened).toBe(isMonday ? 1 : 2); // today (+ yesterday when in-week)
    expect(a.totalListenSec).toBe(isMonday ? 700 : 1400);
    expect(a.lastListenedAt).not.toBeNull();
    // today qualifies for A
    expect(a.weeklyStreak.find((e) => e.date === dayKey(today))!.state).toBe('burning');
    expect(a.weeklyStreak).toHaveLength(7);
  });

  it('does not count sub-threshold listens (course B today = 100s < 600s)', async () => {
    const b = await stats.courseStats(memberId, courseB);
    expect(b.totalListenSec).toBe(100); // total is raw seconds, not gated
    expect(b.lastListenedAt).not.toBeNull();
    expect(b.weeklyStreak.every((e) => e.state !== 'burning')).toBe(true);
  });

  it('does not count a day that fell short of the 10-minute bar', async () => {
    // Course B is 100s on one day — listened to, but not enough to count the day.
    const b = await stats.courseStats(memberId, courseB);
    expect(b.daysListened).toBe(0);
  });

  it('counts a day reached by several short sittings, not one unbroken 10 minutes', async () => {
    // Course C: 250 + 250 + 250 on ONE day. Gating individual sessions on
    // MIN_QUALIFY_SEC would return 0 here while the streak counted the same night.
    const c = await stats.courseStats(memberId, courseC);
    expect(c.daysListened).toBe(1);
    expect(c.totalListenSec).toBe(750);
  });

  it('scopes daysListened to the requested course', async () => {
    const [a, b, c] = await Promise.all([
      stats.courseStats(memberId, courseA),
      stats.courseStats(memberId, courseB),
      stats.courseStats(memberId, courseC),
    ]);
    // Each course sums only its own audio: A and C qualify today, B does not.
    expect(a.daysListened).toBe(isMonday ? 1 : 2);
    expect(b.daysListened).toBe(0);
    expect(c.daysListened).toBe(1);
  });

  it('returns zeros/null for a never-listened course (not an error)', async () => {
    const c = await stats.courseStats(memberId, courseNever);
    expect(c).toMatchObject({
      courseId: courseNever,
      daysListened: 0,
      totalListenSec: 0,
      lastListenedAt: null,
    });
    expect(c.weeklyStreak).toHaveLength(7);
    expect(c.weeklyStreak.every((e) => e.state !== 'burning')).toBe(true);
  });
});
