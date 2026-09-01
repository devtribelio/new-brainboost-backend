import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { MIN_QUALIFY_SEC } from '../apps/mobile-api/src/modules/tracker/tracker.constants';
import {
  addDays,
  dayKey,
  toListeningDayWIB,
  toLocalDayWIB,
} from '../apps/mobile-api/src/modules/tracker/tracker.time';
import { computeStreakState } from '../apps/mobile-api/src/modules/tracker/tracker.streak';

/**
 * READ-ONLY what-if: how one member's streak changes under each pending fix.
 *
 * Writes nothing — no migration, no backfill, no settings. Safe to run against
 * production, and the only way to check a specific complaint before committing to
 * either the `local_day` migration or the Firebase backfill.
 *
 * Three columns, because the fixes are independent and answer different failures:
 *   sekarang  — stored `local_day` (midnight boundary), strict. What the member sees today.
 *   +migrasi  — `local_day` recomputed at the 04:00 boundary. Recovers sessions that are
 *               IN the database but bucketed to the wrong night (class 1).
 *   +grace    — the above plus graceDays. Forgives one recent missed day.
 *
 * A member whose sessions were never written at all (class 2 — the app discarded the
 * checkpoints) shows NO improvement here, which is exactly the signal that their days
 * can only come back from the Firebase export.
 *
 * Usage: pnpm streak:whatif <email|uuid> [more...] [--grace=1] [--days=21]
 */
const args = process.argv.slice(2);
const idents = args.filter((a) => !a.startsWith('--'));
const GRACE = Number(args.find((a) => a.startsWith('--grace='))?.slice(8) ?? 1);
const WINDOW = Number(args.find((a) => a.startsWith('--days='))?.slice(7) ?? 21);

const prisma = new PrismaClient();

function sumByDay(
  sessions: { startedAt: Date; listenedSec: number; localDay: Date }[],
  bucket: 'stored' | 'listening',
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const day = bucket === 'stored' ? s.localDay : toListeningDayWIB(s.startedAt);
    const k = dayKey(day);
    totals.set(k, (totals.get(k) ?? 0) + s.listenedSec);
  }
  return totals;
}

/**
 * Longest run of consecutive qualifying days, ever — computed STRICTLY (no grace,
 * which is anchored on today and so has no meaning in history).
 *
 * The current streak alone cannot validate the fix: a member whose run was broken
 * weeks ago reads 0 either way. What proves the boundary change worked is the peak
 * moving — Giska's 6-day run (08-21 → 08-26) becoming 7 once the night that started
 * 28 Aug 00:01 is filed under the 27th. That is the acceptance number in the spec.
 *
 * Ties resolve to the most recent run.
 */
function longestRun(days: Date[]): { len: number; from: string; to: string } {
  const keys = [...new Set(days.map(dayKey))].sort();
  let best = { len: 0, from: '-', to: '-' };
  let runStart = 0;
  for (let i = 0; i < keys.length; i++) {
    const prev = i > 0 ? keys[i - 1] : null;
    const isNext = prev !== null && dayKey(addDays(new Date(`${prev}T00:00:00.000Z`), 1)) === keys[i];
    if (!isNext) runStart = i;
    const len = i - runStart + 1;
    if (len >= best.len) best = { len, from: keys[runStart]!, to: keys[i]! };
  }
  return best;
}

const qualifying = (totals: Map<string, number>): Date[] =>
  [...totals.entries()]
    .filter(([, sec]) => sec >= MIN_QUALIFY_SEC)
    .map(([k]) => new Date(`${k}T00:00:00.000Z`));

async function main() {
  if (idents.length === 0) {
    throw new Error('usage: pnpm streak:whatif <email|uuid> [more...] [--grace=1] [--days=21]');
  }
  const now = new Date();
  // Anchors differ per scenario on purpose: before the migration the app anchors on the
  // calendar day, after it on the listening day. At 02:00 WIB those are different days.
  const todayStored = toLocalDayWIB(now);
  const todayListening = toListeningDayWIB(now);

  for (const ident of idents) {
    const member = await prisma.member.findFirst({
      where: ident.includes('@') ? { email: ident } : { id: ident },
      select: { id: true, email: true, fullName: true },
    });
    if (!member) {
      console.log(`\n${ident}: NOT FOUND`);
      continue;
    }

    const sessions = await prisma.listeningSession.findMany({
      where: { memberId: member.id },
      select: { startedAt: true, listenedSec: true, localDay: true, source: true },
      orderBy: { startedAt: 'asc' },
    });

    const stored = sumByDay(sessions, 'stored');
    const listening = sumByDay(sessions, 'listening');

    const now0 = computeStreakState(qualifying(stored), todayStored, 0);
    const mig = computeStreakState(qualifying(listening), todayListening, 0);
    const grace = computeStreakState(qualifying(listening), todayListening, GRACE);

    console.log(`\n=== ${member.email ?? member.id}  (${member.fullName ?? '-'}) ===`);
    console.log(`rows=${sessions.length}  first=${sessions[0]?.startedAt.toISOString().slice(0, 10) ?? '-'}  last=${sessions.at(-1)?.startedAt.toISOString().slice(0, 10) ?? '-'}`);
    console.log(
      `streak kini   sekarang=${now0.days} (${now0.state})` +
        `   +migrasi=${mig.days} (${mig.state})` +
        `   +grace${GRACE}=${grace.days} (${grace.state})`,
    );

    const lonNow = longestRun(qualifying(stored));
    const lonMig = longestRun(qualifying(listening));
    console.log(
      `longest       sekarang=${lonNow.len} (${lonNow.from}..${lonNow.to})` +
        `   +migrasi=${lonMig.len} (${lonMig.from}..${lonMig.to})`,
    );

    console.log(`\n  hari         tersimpan   hari-dengar   (${WINDOW} hari terakhir)`);
    for (let i = WINDOW - 1; i >= 0; i--) {
      const d = dayKey(addDays(todayListening, -i));
      const a = stored.get(d) ?? 0;
      const b = listening.get(d) ?? 0;
      if (a === 0 && b === 0) continue;
      const mark = (n: number) => `${String(n).padStart(6)}s ${n >= MIN_QUALIFY_SEC ? '*' : ' '}`;
      const moved = a !== b ? '  <- pindah' : '';
      console.log(`  ${d}   ${mark(a)}    ${mark(b)}${moved}`);
    }

    // The signature that separates "never listened" from "the app threw it away".
    const micro = sessions.filter((s) => {
      const hour = new Date(s.startedAt.getTime() + 7 * 3_600_000).getUTCHours();
      const day = dayKey(toListeningDayWIB(s.startedAt));
      return (listening.get(day) ?? 0) < MIN_QUALIFY_SEC && (hour >= 21 || hour < 4);
    });
    if (micro.length) {
      console.log(`\n  sesi mikro di jam tidur pada hari yang tidak qualify: ${micro.length}`);
      for (const s of micro.slice(-5)) {
        console.log(
          `    ${s.startedAt.toISOString()}  ${s.listenedSec}s  source=${s.source ?? 'null'}`,
        );
      }
      console.log('    ^ "dimulai, tidak pernah difinalisasi" — kandidat kelas 2, tidak dipulihkan migrasi');
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[streak:whatif] fatal:', e);
  await prisma.$disconnect();
  process.exit(1);
});
