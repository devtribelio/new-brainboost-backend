import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';
import { addDays, dayKey, toLocalDayWIB, weekStartMondayWIB } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Noon WIB (05:00Z) instant for a UTC-midnight WIB day — always inside that WIB day. */
function noonWibOf(day: Date): Date {
  return new Date(day.getTime() + 5 * 3_600_000);
}

describe('StatsService.home weeklyStreak strip (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();
  let memberId = '';

  const today = toLocalDayWIB(new Date());
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

  it('marks today qualified, never qualifies a future or sub-threshold day', async () => {
    const res = await stats.home(memberId);
    const todayKey = dayKey(today);

    const todayEntry = res.weeklyStreak.find((e) => e.date === todayKey)!;
    expect(todayEntry.qualified).toBe(true);

    // Future days (lexicographic YYYY-MM-DD compare) are always not-yet-qualified.
    for (const e of res.weeklyStreak) {
      if (e.date > todayKey) expect(e.qualified).toBe(false);
    }

    // Sub-threshold day (100s < 600s) must not qualify.
    if (!isMonday) {
      const yKey = dayKey(addDays(today, -1));
      expect(res.weeklyStreak.find((e) => e.date === yKey)!.qualified).toBe(false);
    }

    // Isolated member: exactly one qualifying day (today).
    expect(res.weeklyStreak.filter((e) => e.qualified).length).toBe(1);
  });
});
