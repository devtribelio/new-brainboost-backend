import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { ERROR_CODES } from '@bb/common/exceptions';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * An instant exactly `daysAgo` whole days before now.
 *
 * A whole-day shift keeps the time-of-day, so it lands `daysAgo` LISTENING days
 * back whatever the boundary is, and is never in the future — a fixed noon-WIB
 * timestamp would be, whenever the suite runs before 12:00 WIB, and the
 * future-clock guard now rejects that.
 */
function listeningDaysAgo(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 86_400_000);
}

describe('Listening tracker (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();

  let memberId = '';
  let courseId = '';
  let productId = '';

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `tracker-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    const product = await prisma.product.create({
      data: { type: 'course', title: 'Stop Smoking', code: `STOPSMOKE-${uid()}` },
    });
    productId = product.id;
    const course = await prisma.course.create({ data: { productId, programDays: 90 } });
    courseId = course.id;
    await prisma.courseEnrollment.create({ data: { memberId, courseId } });

    // 3 consecutive qualifying days (global). Today's qualifying listen is on the course.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: listeningDaysAgo(2).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: listeningDaysAgo(1).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId, startedAt: listeningDaysAgo(0).toISOString(), listenedSec: 700, completed: true },
      'android',
    );
    // A sub-threshold session that must NOT count toward sessionsPlayed.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: listeningDaysAgo(0).toISOString(), listenedSec: 20, completed: false },
      'android',
    );
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('record() is idempotent by (memberId, clientSessionId) — re-send updates, no new row', async () => {
    const csid = crypto.randomUUID();
    const audioId = crypto.randomUUID();
    const startedAt = listeningDaysAgo(0).toISOString();

    await tracking.record(memberId, { clientSessionId: csid, audioId, courseId: null, startedAt, listenedSec: 100, completed: false }, 'ios');
    await tracking.record(memberId, { clientSessionId: csid, audioId, courseId: null, startedAt, listenedSec: 450, completed: true }, 'ios');

    const rows = await prisma.listeningSession.findMany({ where: { memberId, clientSessionId: csid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].listenedSec).toBe(450);
    expect(rows[0].completed).toBe(true);

    await prisma.listeningSession.deleteMany({ where: { memberId, clientSessionId: csid } });
  });

  /** Write one session and return the `local_day` it landed on. */
  async function localDayFor(startedAt: string): Promise<string> {
    const csid = crypto.randomUUID();
    await tracking.record(memberId, { clientSessionId: csid, audioId: crypto.randomUUID(), courseId: null, startedAt, listenedSec: 60, completed: false }, 'ios');
    const row = await prisma.listeningSession.findFirstOrThrow({ where: { memberId, clientSessionId: csid } });
    await prisma.listeningSession.deleteMany({ where: { memberId, clientSessionId: csid } });
    return row.localDay.toISOString().slice(0, 10);
  }

  it('record() credits a session that crosses midnight to the night it started', async () => {
    // 16:59Z = 23:59 WIB on the 10th; 17:30Z = 00:30 WIB on the 11th.
    // Both are the same night, so both belong to listening day the 10th.
    expect(await localDayFor('2026-01-10T16:59:00Z')).toBe('2026-01-10');
    expect(await localDayFor('2026-01-10T17:30:00Z')).toBe('2026-01-10');
  });

  it('record() rolls over to the next listening day at 04:00 WIB', async () => {
    expect(await localDayFor('2026-01-10T20:59:00Z')).toBe('2026-01-10'); // 03:59 WIB 11th
    expect(await localDayFor('2026-01-10T21:00:00Z')).toBe('2026-01-11'); // 04:00 WIB 11th
  });

  it('record() rejects a startedAt beyond the clock-skew allowance', async () => {
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    await expect(
      tracking.record(memberId, { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: future, listenedSec: 700, completed: false }, 'ios'),
    ).rejects.toMatchObject({ code: ERROR_CODES.TRACKING_STARTED_AT_IN_FUTURE });
  });

  it('record() accepts a startedAt inside the clock-skew allowance', async () => {
    const nearFuture = new Date(Date.now() + 60_000).toISOString();
    const csid = crypto.randomUUID();
    await tracking.record(memberId, { clientSessionId: csid, audioId: crypto.randomUUID(), courseId: null, startedAt: nearFuture, listenedSec: 40, completed: false }, 'ios');
    await prisma.listeningSession.deleteMany({ where: { memberId, clientSessionId: csid } });
  });

  it('home() returns lifetime sessions/total, a 3-day streak, and the program challenge', async () => {
    const res = await stats.home(memberId);

    // 3 qualifying sessions + 1 sub-threshold (strays above were deleted) → sessionsPlayed counts ≥30s only.
    expect(res.sessionsPlayed).toBe(3);
    expect(res.totalListenSec).toBe(700 * 3 + 20);
    expect(res.streakDays).toBe(3);

    const challenge = res.challenges.find((c) => c.courseId === courseId);
    expect(challenge).toBeDefined();
    expect(challenge!.title).toBe('Stop Smoking');
    expect(challenge!.code).toMatch(/^STOPSMOKE-/);
    expect(challenge!.day).toBe(1); // only today qualifies for this course
    expect(challenge!.target).toBe(90); // from Course.programDays

    // Additive streak block; root streakDays stays for clients that predate it.
    expect(res.streak.days).toBe(res.streakDays);
    expect(res.streak.state).toBe('burning'); // today qualifies in the fixture
    expect(res.streak.restoreDeadline).toBeNull(); // only a dimmed streak has a deadline
    expect(res.streak.dayBoundaryHour).toBe(4);

    expect(res.weeklyRecap.streakDays).toBe(3);
    expect(res.weeklyRecap.daysTarget).toBe(7);
    expect(res.weeklyRecap.weekNumber).toBeGreaterThanOrEqual(1);
    expect(res.weeklyRecap.daysActive).toBeGreaterThanOrEqual(1);
    expect(res.weeklyRecap.listenSec).toBeGreaterThanOrEqual(700);
  });
});
