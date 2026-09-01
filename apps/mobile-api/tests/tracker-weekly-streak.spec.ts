import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';
import { addDays, dayKey, toListeningDayWIB, weekStartMondayWIB } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Noon WIB (05:00Z) instant for a UTC-midnight listening day — safely inside it. */
function noonWibOf(day: Date): Date {
  return new Date(day.getTime() + 5 * 3_600_000);
}

describe('StatsService.home weeklyStreak strip (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();
  let memberId = '';

  // The service anchors on the LISTENING day; the fixture must use the same one, or
  // a run between 00:00 and 04:00 WIB seeds a different day than it asserts against.
  const today = toListeningDayWIB(new Date());
  const weekStart = weekStartMondayWIB(today);
  const isMonday = today.getTime() === weekStart.getTime();

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `wstreak-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    // Qualifying listen today (≥ MIN_QUALIFY_SEC).
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibOf(today).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
    // Sub-threshold listen yesterday — proves the 600s gate. Only seed when
    // yesterday is still in the current week (i.e. today is not Monday).
    if (!isMonday) {
      await tracking.record(
        memberId,
        { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibOf(addDays(today, -1)).toISOString(), listenedSec: 100, completed: false },
        'ios',
      );
    }
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('returns exactly 7 entries, Monday→Sunday of the current WIB week', async () => {
    const res = await stats.home(memberId);
    expect(res.weeklyStreak).toHaveLength(7);
    const expectedDates = Array.from({ length: 7 }, (_, i) => dayKey(addDays(weekStart, i)));
    expect(res.weeklyStreak.map((e) => e.date)).toEqual(expectedDates);
  });

  it('includes today (WIB) and the qualify threshold in the payload', async () => {
    const res = await stats.home(memberId);
    expect(res.today).toBe(dayKey(today));
    expect(res.qualifyThresholdSec).toBe(600);
    expect(res.weeklyStreak.some((e) => e.date === res.today)).toBe(true);
  });

  it('burns today, and never burns a future or sub-threshold day', async () => {
    const res = await stats.home(memberId);
    const todayKey = dayKey(today);

    // A day that qualified is `burning` even when it is today — the qualified branch
    // has to win over the today branch, or listening would flip the circle backwards.
    expect(res.weeklyStreak.find((e) => e.date === todayKey)!.state).toBe('burning');

    for (const e of res.weeklyStreak) {
      if (e.date > todayKey) expect(e.state).toBe('future');
    }

    // Sub-threshold day (100s < 600s) is a miss, not a burn.
    if (!isMonday) {
      const yKey = dayKey(addDays(today, -1));
      expect(res.weeklyStreak.find((e) => e.date === yKey)!.state).not.toBe('burning');
    }

    // Isolated member: exactly one burning day (today).
    expect(res.weeklyStreak.filter((e) => e.state === 'burning')).toHaveLength(1);
  });

  it('never reports a past day as future, or more than one day as at_risk', async () => {
    const res = await stats.home(memberId);
    const todayKey = dayKey(today);

    for (const e of res.weeklyStreak) {
      if (e.date < todayKey) expect(e.state).not.toBe('future');
      if (e.date !== todayKey) expect(e.state).not.toBe('at_risk');
    }
    // at_risk is today-only, and only while today has not qualified. It has.
    expect(res.weeklyStreak.filter((e) => e.state === 'at_risk')).toHaveLength(0);
  });

  it('uses the same vocabulary as the headline streak', async () => {
    const res = await stats.home(memberId);
    const dayStates = new Set(['burning', 'at_risk', 'dimmed', 'none', 'future']);

    for (const e of res.weeklyStreak) expect(dayStates.has(e.state)).toBe(true);
    // The headline can never be `future` — only a day can lie ahead.
    expect(res.streak.state).not.toBe('future');
    expect(dayStates.has(res.streak.state)).toBe(true);
  });
});

describe('weeklyStreak states a member has to earn (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();
  let memberId = '';

  const today = toListeningDayWIB(new Date());
  const weekStart = weekStartMondayWIB(today);
  /** Days back from today that are still inside the current week. */
  const inWeek = (back: number) => addDays(today, -back).getTime() >= weekStart.getTime();

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `wstate-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    // Qualify two days ago, miss yesterday, nothing today: grace carries the streak,
    // so yesterday is `dimmed` and today is `at_risk`.
    if (inWeek(2)) {
      await tracking.record(
        memberId,
        { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibOf(addDays(today, -2)).toISOString(), listenedSec: 700, completed: true },
        'ios',
      );
    }
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
  });

  it('marks today at_risk while it has not qualified yet', async () => {
    const res = await stats.home(memberId);
    expect(res.weeklyStreak.find((e) => e.date === dayKey(today))!.state).toBe('at_risk');
  });

  it('marks a grace-forgiven day dimmed, and the headline agrees', async () => {
    if (!inWeek(2)) return; // early in the week the fixture days fall outside the strip
    const res = await stats.home(memberId);

    expect(res.streak.state).toBe('dimmed');
    expect(res.weeklyStreak.find((e) => e.date === dayKey(addDays(today, -1)))!.state).toBe('dimmed');
    // The day that actually carried the streak still burns.
    expect(res.weeklyStreak.find((e) => e.date === dayKey(addDays(today, -2)))!.state).toBe('burning');
  });

  it('marks an unforgiven miss `none`, not `dimmed`', async () => {
    if (!inWeek(3)) return;
    const res = await stats.home(memberId);
    // Three days back was never listened to and sits outside the grace window.
    expect(res.weeklyStreak.find((e) => e.date === dayKey(addDays(today, -3)))!.state).toBe('none');
  });
});
