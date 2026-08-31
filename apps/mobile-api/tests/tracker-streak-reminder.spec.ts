import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@bb/db';
import { SettingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import {
  streakReminder,
  collectStreakReminders,
  wibHour,
} from '@/modules/tracker/streak-reminder.job';
import { toListeningDayWIB, addDays, dayKey } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** Fixed "now": 21:00 WIB on 2026-08-28 (14:00Z) — the at-risk hour. */
const NOW = new Date('2026-08-28T14:00:00Z');
const TODAY = toListeningDayWIB(NOW);

describe('streak reminder job (real Postgres)', () => {
  const members: string[] = [];

  async function member(): Promise<string> {
    const m = await prisma.member.create({
      data: { email: `streak-${uid()}@test.local`, passwordHash: 'x' },
    });
    members.push(m.id);
    return m.id;
  }

  /** Give `memberId` a qualifying listening day `daysAgo` listening days before today. */
  async function qualify(memberId: string, daysAgo: number, sec = 700) {
    const day = addDays(TODAY, -daysAgo);
    await prisma.listeningSession.create({
      data: {
        memberId,
        clientSessionId: crypto.randomUUID(),
        audioId: 'a',
        // Noon WIB of that listening day (05:00Z) is safely inside it.
        startedAt: new Date(day.getTime() + 5 * 3_600_000),
        listenedSec: sec,
        completed: false,
        localDay: day,
        source: 'ios',
      },
    });
  }

  beforeAll(async () => {
    await new SettingsService().set(SETTING_KEYS.streakGraceDays, '1');
  });

  beforeEach(() => {
    SettingsService.clearCache();
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId: { in: members } } });
    await prisma.notification.deleteMany({ where: { memberId: { in: members } } });
    await prisma.member.deleteMany({ where: { id: { in: members } } });
    await prisma.appSetting.deleteMany({
      where: {
        key: {
          in: [
            SETTING_KEYS.streakGraceDays,
            SETTING_KEYS.streakAtRiskEnabled,
            SETTING_KEYS.streakDimmedEnabled,
          ],
        },
      },
    });
    SettingsService.clearCache();
    await prisma.$disconnect();
  });

  it('reads the WIB hour of the tick', () => {
    expect(wibHour(NOW)).toBe(21);
  });

  it('is a no-op while the setting ships disabled', async () => {
    const res = await streakReminder(NOW);
    expect(res.skipped).toBe('disabled');
    expect(res.pushed).toBe(0);
  });

  it('silences one send without touching the other', async () => {
    const settings = new SettingsService();
    await settings.set(SETTING_KEYS.streakAtRiskEnabled, 'true');
    await settings.set(SETTING_KEYS.streakDimmedEnabled, 'false');
    SettingsService.clearCache();

    // 21:00 WIB — the at-risk hour, switched on. Dry run: the gate is what is under
    // test, and a real sweep here would write rows for members other specs own.
    expect((await streakReminder(NOW, { dryRun: true })).skipped).toBeUndefined();
    // 09:00 WIB (02:00Z) — the dimmed hour, switched off. Reports itself, not the other.
    const morning = await streakReminder(new Date('2026-08-28T02:00:00Z'));
    expect(morning.skipped).toBe('disabled');
    expect(morning.mode).toBe('dimmed');

    await settings.set(SETTING_KEYS.streakAtRiskEnabled, 'false');
    SettingsService.clearCache();
  });

  it('skips an hour that is neither send time', async () => {
    await new SettingsService().set(SETTING_KEYS.streakAtRiskEnabled, 'true');
    SettingsService.clearCache();
    // 10:00 WIB — not 21 (at-risk) and not 9 (dimmed).
    const res = await streakReminder(new Date('2026-08-28T03:00:00Z'));
    expect(res.skipped).toBe('wrong-hour');
  });

  it('warns a member who kept a streak but has not listened today', async () => {
    const id = await member();
    await qualify(id, 1);
    await qualify(id, 2);
    await qualify(id, 3);

    const plan = await collectStreakReminders('at_risk', 1, NOW);
    expect(plan.find((p) => p.memberId === id)).toEqual({ memberId: id, days: 3 });
  });

  it('does not warn a streak below the minimum', async () => {
    const id = await member();
    await qualify(id, 1);
    await qualify(id, 2); // only 2 days — under MIN_STREAK_FOR_AT_RISK

    const plan = await collectStreakReminders('at_risk', 1, NOW);
    expect(plan.find((p) => p.memberId === id)).toBeUndefined();
  });

  it('does not warn a member who already listened today', async () => {
    const id = await member();
    await qualify(id, 0);
    await qualify(id, 1);
    await qualify(id, 2);
    await qualify(id, 3);

    const plan = await collectStreakReminders('at_risk', 1, NOW);
    expect(plan.find((p) => p.memberId === id)).toBeUndefined();
  });

  it('picks up a dimmed member the morning after the missed day', async () => {
    const id = await member();
    await qualify(id, 2);
    await qualify(id, 3); // yesterday (1) missing → grace carries it

    const atRisk = await collectStreakReminders('at_risk', 1, NOW);
    expect(atRisk.find((p) => p.memberId === id)).toBeUndefined();

    const dimmed = await collectStreakReminders('dimmed', 1, NOW);
    expect(dimmed.find((p) => p.memberId === id)).toEqual({ memberId: id, days: 2 });
  });

  it('says nothing to a member whose streak is already gone', async () => {
    const id = await member();
    await qualify(id, 3);
    await qualify(id, 4); // days 1 AND 2 missing → streak 0, no push at 0

    for (const mode of ['at_risk', 'dimmed'] as const) {
      const plan = await collectStreakReminders(mode, 1, NOW);
      expect(plan.find((p) => p.memberId === id)).toBeUndefined();
    }
  });

  it('has no dimmed candidates at all when grace is off', async () => {
    await new SettingsService().set(SETTING_KEYS.streakAtRiskEnabled, 'true');
    await new SettingsService().set(SETTING_KEYS.streakGraceDays, '0');
    SettingsService.clearCache();

    const res = await streakReminder(new Date('2026-08-28T02:00:00Z'), {
      force: true,
      mode: 'dimmed',
    });
    expect(res.candidates).toBe(0);

    await new SettingsService().set(SETTING_KEYS.streakGraceDays, '1');
    SettingsService.clearCache();
  });

  it('writes one notification per member per day and dedupes a second run', async () => {
    const id = await member();
    await qualify(id, 1);
    await qualify(id, 2);
    await qualify(id, 3);
    await new SettingsService().set(SETTING_KEYS.streakAtRiskEnabled, 'true');
    SettingsService.clearCache();

    await streakReminder(NOW, { force: true, mode: 'at_risk', memberId: id });
    await streakReminder(NOW, { force: true, mode: 'at_risk', memberId: id }); // cron restart in the same hour

    const rows = await prisma.notification.findMany({ where: { memberId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('streakAtRisk');
    expect(rows[0].title).toBe('Streak 3 hari belum aman');
    expect(rows[0].dedupeKey).toBe(`streakAtRisk:${id}:${dayKey(TODAY)}`);
  });

  it('dry run reports the plan without writing anything', async () => {
    const id = await member();
    await qualify(id, 1);
    await qualify(id, 2);
    await qualify(id, 3);

    const res = await streakReminder(NOW, { force: true, mode: 'at_risk', dryRun: true, memberId: id });
    expect(res.preview?.some((p) => p.memberId === id)).toBe(true);
    expect(res.pushed).toBe(0);
    expect(await prisma.notification.count({ where: { memberId: id } })).toBe(0);
  });
});
