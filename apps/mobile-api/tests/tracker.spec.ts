import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Noon WIB (05:00Z) of `daysAgo` days before today — always inside one WIB day. */
function noonWibDaysAgo(daysAgo: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  d.setUTCHours(5, 0, 0, 0); // 12:00 WIB
  return d;
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
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibDaysAgo(2).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibDaysAgo(1).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId, startedAt: noonWibDaysAgo(0).toISOString(), listenedSec: 700, completed: true },
      'android',
    );
    // A sub-threshold session that must NOT count toward sessionsPlayed.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibDaysAgo(0).toISOString(), listenedSec: 20, completed: false },
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
    const startedAt = noonWibDaysAgo(0).toISOString();

    await tracking.record(memberId, { clientSessionId: csid, audioId, courseId: null, startedAt, listenedSec: 100, completed: false }, 'ios');
    await tracking.record(memberId, { clientSessionId: csid, audioId, courseId: null, startedAt, listenedSec: 450, completed: true }, 'ios');

    const rows = await prisma.listeningSession.findMany({ where: { memberId, clientSessionId: csid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].listenedSec).toBe(450);
    expect(rows[0].completed).toBe(true);

    await prisma.listeningSession.deleteMany({ where: { memberId, clientSessionId: csid } });
  });

  it('record() derives WIB local_day from startedAt', async () => {
    const csid = crypto.randomUUID();
    // 17:30Z = 00:30 WIB next day.
    await tracking.record(memberId, { clientSessionId: csid, audioId: crypto.randomUUID(), courseId: null, startedAt: '2026-01-10T17:30:00Z', listenedSec: 60, completed: false }, 'ios');
    const row = await prisma.listeningSession.findFirstOrThrow({ where: { memberId, clientSessionId: csid } });
    expect(row.localDay.toISOString().slice(0, 10)).toBe('2026-01-11');
    await prisma.listeningSession.deleteMany({ where: { memberId, clientSessionId: csid } });
  });

  it('home() returns lifetime sessions/total, a 3-day streak, and the program challenge', async () => {
    const res = await stats.home(memberId);

    // 3 qualifying sessions + 1 sub-threshold + (2026-01 stray was deleted) → sessionsPlayed counts ≥30s only.
    expect(res.sessionsPlayed).toBe(3);
    expect(res.totalListenSec).toBe(700 * 3 + 20);
    expect(res.streakDays).toBe(3);

    const challenge = res.challenges.find((c) => c.courseId === courseId);
    expect(challenge).toBeDefined();
    expect(challenge!.title).toBe('Stop Smoking');
    expect(challenge!.code).toMatch(/^STOPSMOKE-/);
    expect(challenge!.day).toBe(1); // only today qualifies for this course
    expect(challenge!.target).toBe(90); // from Course.programDays

    expect(res.weeklyRecap.streakDays).toBe(3);
    expect(res.weeklyRecap.daysTarget).toBe(7);
    expect(res.weeklyRecap.weekNumber).toBeGreaterThanOrEqual(1);
    expect(res.weeklyRecap.daysActive).toBeGreaterThanOrEqual(1);
    expect(res.weeklyRecap.listenSec).toBeGreaterThanOrEqual(700);
  });
});
