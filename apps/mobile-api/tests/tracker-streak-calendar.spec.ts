import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';
import { addDays, dayKey, monthKey, toListeningDayWIB } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Noon WIB (05:00Z) instant for a UTC-midnight listening day — safely inside it. */
function noonWibOf(day: Date): Date {
  return new Date(day.getTime() + 5 * 3_600_000);
}

/** Shift a `YYYY-MM` key by whole months. */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

describe('StatsService.streakCalendar (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();
  let memberId = '';

  // Anchor on the LISTENING day, like the service does: a run between 00:00 and
  // 04:00 WIB would otherwise seed a different day than it asserts against.
  const today = toListeningDayWIB(new Date());
  const todayKey = dayKey(today);
  const thisMonth = monthKey(today);

  // Qualifying today, yesterday and two days back; a sub-threshold session four days
  // back is the FIRST tracked day — it must appear as `none`, never be omitted.
  const qualifyDays = [0, 1, 2].map((back) => addDays(today, -back));
  const firstTracked = addDays(today, -4);

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `cal-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    for (const d of qualifyDays) {
      await tracking.record(
        memberId,
        { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibOf(d).toISOString(), listenedSec: 700, completed: true },
        'ios',
      );
    }
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: null, startedAt: noonWibOf(firstTracked).toISOString(), listenedSec: 100, completed: false },
      'ios',
    );
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
  });

  it('defaults to the month today falls in', async () => {
    const res = await stats.streakCalendar(memberId);
    expect(res.month).toBe(thisMonth);
    expect(res.today).toBe(todayKey);
    expect(res.qualifyThresholdSec).toBe(600);
    expect(res.dayBoundaryHour).toBe(4);
  });

  it('omits every date after today and before the first tracked day', async () => {
    const res = await stats.streakCalendar(memberId, thisMonth);
    const firstKey = dayKey(firstTracked);

    for (const d of res.days) {
      expect(d.date <= todayKey).toBe(true);
      expect(d.date >= firstKey).toBe(true);
      expect(d.state).not.toBe('future'); // absence covers the future, not a label
    }
    // Today is present, and is `burning` because it qualified.
    expect(res.days.find((d) => d.date === todayKey)!.state).toBe('burning');
  });

  it('reports the first tracked day as a miss, not as absent', async () => {
    // Ask for the month the first tracked day is actually in, so this holds wherever
    // in the month the suite happens to run.
    const res = await stats.streakCalendar(memberId, monthKey(firstTracked));
    // 100s < 600s: the day was tracked but did not qualify.
    expect(res.days.find((d) => d.date === dayKey(firstTracked))!.state).toBe('none');
  });

  it('starts the first month of history AT the first tracked day, not at the 1st', async () => {
    // The real test of the omit-before-history rule: a member who started mid-month
    // must not see the earlier days of that month as thirty missed days.
    const firstMonth = monthKey(firstTracked);
    const res = await stats.streakCalendar(memberId, firstMonth);
    expect(res.days.length).toBeGreaterThan(0);
    expect(res.days[0].date).toBe(dayKey(firstTracked));
  });

  it('ends the current month AT today, never past it', async () => {
    const res = await stats.streakCalendar(memberId, thisMonth);
    // An empty array would satisfy a "no date is after today" loop, so pin the tail.
    expect(res.days[res.days.length - 1].date).toBe(todayKey);
  });

  it('returns a contiguous run of dates — gaps only ever at the two ends', async () => {
    // `longestRun` walks this list in order and treats adjacency as calendar
    // adjacency, so a hole in the middle would silently join two separate runs.
    const res = await stats.streakCalendar(memberId, thisMonth);
    for (let i = 1; i < res.days.length; i += 1) {
      const prev = new Date(`${res.days[i - 1].date}T00:00:00.000Z`);
      expect(res.days[i].date).toBe(dayKey(addDays(prev, 1)));
    }
  });

  it('counts qualifiedDays as the qualifying days that fall inside the month', async () => {
    const res = await stats.streakCalendar(memberId, thisMonth);
    const expected = qualifyDays.filter((d) => monthKey(d) === thisMonth).length;
    expect(res.qualifiedDays).toBe(expected);
    expect(res.days.filter((d) => d.state === 'burning')).toHaveLength(expected);
  });

  it('reports longestRun over the qualifying block, clipped to the month', async () => {
    const res = await stats.streakCalendar(memberId, thisMonth);
    // The three qualifying days are consecutive, so the run is however many of them
    // this month still contains.
    expect(res.longestRun).toBe(qualifyDays.filter((d) => monthKey(d) === thisMonth).length);
  });

  it('agrees with GET /stats/home on the streak number and on every shared day', async () => {
    const [cal, home] = await Promise.all([stats.streakCalendar(memberId), stats.home(memberId)]);

    // The whole reason these fields are duplicated: the dialog can be opened from a
    // home payload that is hours old, and the two must never disagree.
    expect(cal.currentStreak).toBe(home.streakDays);
    expect(cal.today).toBe(home.today);
    expect(cal.qualifyThresholdSec).toBe(home.qualifyThresholdSec);
    expect(cal.dayBoundaryHour).toBe(home.streak.dayBoundaryHour);

    const byDate = new Map(cal.days.map((d) => [d.date, d.state]));
    for (const entry of home.weeklyStreak) {
      if (entry.state === 'future') continue; // the calendar omits these entirely
      const calState = byDate.get(entry.date);
      if (calState === undefined) continue; // strip day outside the requested month
      expect(calState).toBe(entry.state);
    }
  });

  it('carries the member-level fields on a month with no history', async () => {
    // This is the load-bearing rule: those five fields describe the member, not the
    // page. A response for a month before the member joined that dropped
    // `earliestMonth` would strand the pager with no way back.
    const before = shiftMonth(thisMonth, -6);
    const res = await stats.streakCalendar(memberId, before);

    expect(res.month).toBe(before);
    expect(res.days).toEqual([]);
    expect(res.today).toBe(todayKey);
    expect(res.earliestMonth).toBe(monthKey(firstTracked));
    expect(res.currentStreak).toBeGreaterThan(0);
    expect(res.qualifyThresholdSec).toBe(600);
    expect(res.dayBoundaryHour).toBe(4);
  });

  it('answers a future month with an empty day list, not an error', async () => {
    const res = await stats.streakCalendar(memberId, shiftMonth(thisMonth, 3));
    expect(res.days).toEqual([]);
    expect(res.today).toBe(todayKey);
  });

  it('reports earliestMonth from the first TRACKED day, not the first qualifying one', async () => {
    const res = await stats.streakCalendar(memberId);
    expect(res.earliestMonth).toBe(monthKey(firstTracked));
  });
});

describe('streakCalendar for a member who has never listened (real Postgres)', () => {
  const stats = new StatsService();
  let memberId = '';
  const today = toListeningDayWIB(new Date());

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `cal-empty-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
  });

  afterAll(async () => {
    await prisma.member.delete({ where: { id: memberId } });
  });

  it('returns an empty month with a null earliestMonth rather than erroring', async () => {
    const res = await stats.streakCalendar(memberId);
    expect(res.days).toEqual([]);
    expect(res.earliestMonth).toBeNull();
    expect(res.currentStreak).toBe(0);
    expect(res.qualifiedDays).toBe(0);
    expect(res.longestRun).toBe(0);
    // Still enough for the client to draw an empty calendar and disable both arrows.
    expect(res.today).toBe(dayKey(today));
    expect(res.dayBoundaryHour).toBe(4);
  });
});

describe('GET /api/user/stats/streak/calendar (HTTP)', () => {
  const app = buildApp();
  const PASSWORD = 'CalendarPass123';
  let accessToken = '';
  let memberId = '';

  beforeAll(async () => {
    const email = `cal-http-${uid()}@test.local`;
    const m = await prisma.member.create({
      data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), isEmailVerified: true },
    });
    memberId = m.id;

    const res = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password: PASSWORD });
    expect(res.status).toBe(200);
    accessToken = res.body.data.access_token as string;
  });

  afterAll(async () => {
    await prisma.member.delete({ where: { id: memberId } });
  });

  it('rejects an anonymous caller', async () => {
    const res = await request(app).get('/api/user/stats/streak/calendar');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('BEARER_TOKEN_MISSING');
  });

  it('answers the current month when `month` is omitted', async () => {
    const res = await request(app)
      .get('/api/user/stats/streak/calendar')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.month).toBe(monthKey(toListeningDayWIB(new Date())));
    expect(Array.isArray(res.body.data.days)).toBe(true);
  });

  it.each(['2026-13', '2026-00', 'sept', '2026-9', '2026-09-01'])(
    'rejects a malformed month (%s) with 400',
    async (month) => {
      const res = await request(app)
        .get(`/api/user/stats/streak/calendar?month=${month}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('accepts a well-formed month far outside the member history', async () => {
    const res = await request(app)
      .get('/api/user/stats/streak/calendar?month=2019-02')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([]);
    expect(res.body.data.month).toBe('2019-02');
  });
});
