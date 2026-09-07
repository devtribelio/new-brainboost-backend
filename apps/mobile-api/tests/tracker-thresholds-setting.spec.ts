import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { settingsService, SettingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';
import { toListeningDayWIB } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

async function setThreshold(key: string, value: string | null): Promise<void> {
  if (value === null) await prisma.appSetting.deleteMany({ where: { key } });
  else await settingsService.set(key, value);
  SettingsService.clearCache();
}

/**
 * `tracker.qualifySec` and `tracker.minSessionSec` are runtime-configurable; the
 * constants are only fallbacks. These assert the setting is actually in force —
 * without them, a reader wired to the constant would still pass every other spec,
 * because every other spec runs at the default.
 */
describe('tracker thresholds come from app_settings (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();

  let memberId = '';
  let courseId = '';
  let productId = '';
  const today = toListeningDayWIB(new Date());

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `thresh-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
    productId = (await prisma.product.create({ data: { type: 'course', title: 'Thresh', code: `T-${uid()}` } })).id;
    courseId = (await prisma.course.create({ data: { productId, programDays: 30 } })).id;
    await prisma.courseEnrollment.create({ data: { memberId, courseId } });

    // 300s today on the course: under the 600s default, over a lowered 120s bar.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId, startedAt: new Date(today.getTime() + 5 * 3_600_000).toISOString(), listenedSec: 300, completed: false },
      'ios',
    );
  });

  afterEach(async () => {
    await setThreshold(SETTING_KEYS.trackerQualifySec, null);
    await setThreshold(SETTING_KEYS.trackerMinSessionSec, null);
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
  });

  it('falls back to 600s when no row exists', async () => {
    const res = await stats.home(memberId);
    expect(res.qualifyThresholdSec).toBe(600);
    expect(res.streakDays).toBe(0); // 300s < 600s
  });

  it('lowering tracker.qualifySec turns a short day into a qualifying one', async () => {
    await setThreshold(SETTING_KEYS.trackerQualifySec, '120');
    const res = await stats.home(memberId);
    expect(res.streakDays).toBe(1);
    // The number the app renders as "Dengarkan N menit" must move with the rule, or
    // the app states a threshold the backend no longer applies.
    expect(res.qualifyThresholdSec).toBe(120);
  });

  it('carries the change into the per-program challenge and courseStats', async () => {
    await setThreshold(SETTING_KEYS.trackerQualifySec, '120');
    const [home, course] = await Promise.all([
      stats.home(memberId),
      stats.courseStats(memberId, courseId),
    ]);
    expect(home.challenges.find((c) => c.courseId === courseId)!.day).toBe(1);
    expect(course.daysListened).toBe(1);
  });

  it('carries the change into the streak calendar', async () => {
    await setThreshold(SETTING_KEYS.trackerQualifySec, '120');
    const cal = await stats.streakCalendar(memberId);
    expect(cal.qualifyThresholdSec).toBe(120);
    expect(cal.qualifiedDays).toBe(1);
  });

  it('raising tracker.minSessionSec drops the session from sessionsPlayed', async () => {
    const before = await stats.home(memberId);
    expect(before.sessionsPlayed).toBe(1); // 300s ≥ 30s default

    await setThreshold(SETTING_KEYS.trackerMinSessionSec, '600');
    const after = await stats.home(memberId);
    expect(after.sessionsPlayed).toBe(0); // 300s < 600s
    // The two bars are independent: the session floor must not move the streak.
    expect(after.streakDays).toBe(before.streakDays);
  });
});
