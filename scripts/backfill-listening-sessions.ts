import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  MIN_QUALIFY_SEC,
  MIN_SESSION_SEC,
} from '../apps/mobile-api/src/modules/tracker/tracker.constants';
import {
  addDays,
  dayKey,
  toListeningDayWIB,
} from '../apps/mobile-api/src/modules/tracker/tracker.time';
import { computeStreak } from '../apps/mobile-api/src/modules/tracker/tracker.streak';

/**
 * Restore listening sessions the mobile app dropped on the floor (Aug 2026: the
 * tracking gate read a cached profile instead of the token, so every checkpoint
 * was discarded while Firebase still recorded the play). Backend cannot see a
 * discarded session, so the evidence comes from the GA4 export — see
 * `docs/tracker-streak.md` §3.3b for the BigQuery query that produces the CSV.
 *
 * Streak is never stored, so a backfill IS just inserting `listening_session`
 * rows: streak, per-program challenge and the weekly recap all recompute from
 * them on the next read. The listening-day helper is imported rather than
 * reimplemented, so a change to the 04:00 boundary moves the backfill with it.
 *
 * Usage: pnpm tracker:backfill <csv> [--dry-run] [--source=backfill:firebase:2026-08]
 *
 * The CSV contract is query A1's columns verbatim (identity resolution happens
 * here, in Postgres, not in BigQuery):
 *   firebase_user_id, param_member_id, param_email,
 *   started_at_utc, listened_sec, audio_id, product_code, position_sec, total_sec
 */

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CSV_PATH = args.find((a) => !a.startsWith('--'));
const SOURCE =
  args.find((a) => a.startsWith('--source='))?.slice('--source='.length) ??
  `backfill:firebase:${new Date().toISOString().slice(0, 7)}`;

/** Fixed namespace so the same span always derives the same id, across runs and machines. */
const NAMESPACE = '6f1c2b7e-3f1a-4a2e-9d5b-8c7e0a4d1f23';
/** A span whose window touches an existing row's window is assumed to be the same play. */
const OVERLAP_SLACK_SEC = 90;
/** `completed` when the member reached this fraction of the audio. */
const COMPLETED_AT = 0.95;

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[tracker:backfill]${DRY_RUN ? ' [dry-run]' : ''} ${msg}`);
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180 — BigQuery quotes any field containing a comma, quote or newline)
// ---------------------------------------------------------------------------

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  const header = rows.shift();
  if (!header) throw new Error('CSV is empty');
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** BigQuery exports timestamps as `2026-08-26 16:48:00 UTC`; ISO is accepted too. */
function parseTimestamp(raw: string): Date | null {
  if (!raw) return null;
  const normalised = raw.endsWith(' UTC') ? `${raw.slice(0, -4).replace(' ', 'T')}Z` : raw;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** RFC 4122 v5 (SHA-1) — deterministic id per (member, start, audio), so re-runs dedup. */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const chunk = <T,>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

interface Span {
  memberId: string;
  startedAt: Date;
  listenedSec: number;
  audioId: string;
  courseId: string | null;
  completed: boolean;
}

interface Existing {
  startedAt: Date;
  listenedSec: number;
}

// ---------------------------------------------------------------------------

async function resolveMembers(rows: Record<string, string>[]): Promise<Map<string, string>> {
  // A member may appear under several keys: UUID `user_id` (app ≥3.2.3), numeric
  // legacy_id (≤3.2.2), or only an `email` event param. All three map to one id.
  const uuids = new Set<string>();
  const legacyIds = new Set<number>();
  const emails = new Set<string>();

  for (const r of rows) {
    for (const raw of [r.firebase_user_id, r.param_member_id]) {
      const v = raw?.trim();
      if (!v) continue;
      if (UUID_RE.test(v)) uuids.add(v.toLowerCase());
      else if (/^\d+$/.test(v)) legacyIds.add(Number(v));
    }
    const email = r.param_email?.trim().toLowerCase();
    if (email) emails.add(email);
  }

  const map = new Map<string, string>();
  const add = (key: string | number | null, id: string) => {
    if (key !== null && key !== undefined) map.set(String(key).toLowerCase(), id);
  };

  for (const part of chunk([...uuids], 500)) {
    const found = await prisma.member.findMany({
      where: { id: { in: part } },
      select: { id: true, legacyId: true, email: true },
    });
    for (const m of found) { add(m.id, m.id); add(m.legacyId, m.id); add(m.email, m.id); }
  }
  for (const part of chunk([...legacyIds], 500)) {
    const found = await prisma.member.findMany({
      where: { legacyId: { in: part } },
      select: { id: true, legacyId: true, email: true },
    });
    for (const m of found) { add(m.id, m.id); add(m.legacyId, m.id); add(m.email, m.id); }
  }
  for (const part of chunk([...emails], 500)) {
    const found = await prisma.member.findMany({
      where: { email: { in: part } },
      select: { id: true, legacyId: true, email: true },
    });
    for (const m of found) { add(m.id, m.id); add(m.legacyId, m.id); add(m.email, m.id); }
  }
  return map;
}

async function resolveCourses(rows: Record<string, string>[]): Promise<Map<string, string>> {
  const codes = [...new Set(rows.map((r) => r.product_code?.trim()).filter(Boolean) as string[])];
  const map = new Map<string, string>();
  for (const part of chunk(codes, 500)) {
    const products = await prisma.product.findMany({
      where: { code: { in: part } },
      select: { code: true, course: { select: { id: true } } },
    });
    for (const p of products) if (p.code && p.course) map.set(p.code, p.course.id);
  }
  return map;
}

async function loadExisting(memberIds: string[]): Promise<Map<string, Existing[]>> {
  const byMember = new Map<string, Existing[]>();
  for (const part of chunk(memberIds, 500)) {
    const rows = await prisma.listeningSession.findMany({
      where: { memberId: { in: part } },
      select: { memberId: true, startedAt: true, listenedSec: true },
    });
    for (const r of rows) {
      const list = byMember.get(r.memberId) ?? [];
      list.push({ startedAt: r.startedAt, listenedSec: r.listenedSec });
      byMember.set(r.memberId, list);
    }
  }
  return byMember;
}

/** Per-listening-day totals for a set of sessions. */
function dayTotals(sessions: Existing[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const k = dayKey(toListeningDayWIB(s.startedAt));
    totals.set(k, (totals.get(k) ?? 0) + s.listenedSec);
  }
  return totals;
}

function qualifyingDaysOf(totals: Map<string, number>): Date[] {
  return [...totals.entries()]
    .filter(([, sec]) => sec >= MIN_QUALIFY_SEC)
    .map(([k]) => new Date(`${k}T00:00:00.000Z`));
}

function overlaps(span: Span, e: Existing): boolean {
  const aStart = span.startedAt.getTime();
  const aEnd = aStart + span.listenedSec * 1000;
  const bStart = e.startedAt.getTime();
  const bEnd = bStart + e.listenedSec * 1000;
  const slack = OVERLAP_SLACK_SEC * 1000;
  return aStart < bEnd + slack && bStart < aEnd + slack;
}

async function main() {
  if (!CSV_PATH) throw new Error('usage: pnpm tracker:backfill <csv> [--dry-run] [--source=...]');

  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const required = ['started_at_utc', 'listened_sec', 'audio_id'];
  const missing = required.filter((c) => !(c in (rows[0] ?? {})));
  if (missing.length) throw new Error(`CSV missing required column(s): ${missing.join(', ')}`);
  log(`parsed rows=${rows.length} source="${SOURCE}"`);

  const [memberMap, courseMap] = await Promise.all([resolveMembers(rows), resolveCourses(rows)]);

  // ---- rows → spans -------------------------------------------------------
  const spans: Span[] = [];
  let unresolved = 0;
  let unusable = 0;

  for (const r of rows) {
    const keys = [r.firebase_user_id, r.param_member_id, r.param_email]
      .map((v) => v?.trim().toLowerCase())
      .filter(Boolean) as string[];
    const memberId = keys.map((k) => memberMap.get(k)).find(Boolean);
    if (!memberId) { unresolved++; continue; }

    const startedAt = parseTimestamp(r.started_at_utc);
    const listenedSec = Number(r.listened_sec);
    if (!startedAt || !Number.isFinite(listenedSec) || listenedSec < MIN_SESSION_SEC || !r.audio_id) {
      unusable++;
      continue;
    }

    const total = Number(r.total_sec);
    const position = Number(r.position_sec);
    spans.push({
      memberId,
      startedAt,
      listenedSec: Math.round(listenedSec),
      audioId: r.audio_id,
      courseId: courseMap.get(r.product_code?.trim() ?? '') ?? null,
      completed: Number.isFinite(total) && total > 0 && position >= total * COMPLETED_AT,
    });
  }

  log(`spans=${spans.length} unresolvedMember=${unresolved} unusableRow=${unusable}`);
  if (spans.length === 0) { await prisma.$disconnect(); return; }

  // ---- filter against what the backend already has ------------------------
  const memberIds = [...new Set(spans.map((s) => s.memberId))];
  const existing = await loadExisting(memberIds);

  const today = toListeningDayWIB(new Date());
  const keep: Span[] = [];
  let skippedDayOk = 0;
  let skippedDayUnproven = 0;
  let skippedCovered = 0;
  let trimmed = 0;

  // The unit of repair is a DAY, not a span: "impacted" means Firebase saw ≥10 min
  // that day while the backend has < 10 min (docs/tracker-streak.md §3.3b).
  const byDay = new Map<string, Span[]>();
  for (const span of spans) {
    const k = `${span.memberId}|${dayKey(toListeningDayWIB(span.startedAt))}`;
    byDay.set(k, [...(byDay.get(k) ?? []), span]);
  }

  for (const [key, daySpans] of byDay) {
    const [memberId, day] = key.split('|');
    const rowsFor = existing.get(memberId) ?? [];
    const backendSec = dayTotals(rowsFor).get(day) ?? 0;

    // Already qualifying → the day was never broken. Also what makes a re-run a no-op.
    if (backendSec >= MIN_QUALIFY_SEC) { skippedDayOk += daySpans.length; continue; }
    // Firebase does not prove 10 minutes either → nothing to restore, and inserting
    // would only inflate lifetime totals without ever fixing a streak.
    if (daySpans.reduce((n, s) => n + s.listenedSec, 0) < MIN_QUALIFY_SEC) {
      skippedDayUnproven += daySpans.length;
      continue;
    }

    for (const span of daySpans) {
      // The same play often reached the backend PARTIALLY (the app finalised once
      // before the gate dropped the rest), under a different clientSessionId. Insert
      // the shortfall, not the whole span: subtracting what already landed keeps the
      // day total at Firebase's own number instead of double-counting it.
      const covered = rowsFor.filter((e) => overlaps(span, e)).reduce((n, e) => n + e.listenedSec, 0);
      const listenedSec = span.listenedSec - covered;
      if (listenedSec < MIN_SESSION_SEC) { skippedCovered++; continue; }
      if (covered > 0) trimmed++;
      keep.push({ ...span, listenedSec });
    }
  }

  log(
    `toInsert=${keep.length} trimmedByExistingRow=${trimmed} skippedDayAlreadyQualifies=${skippedDayOk}` +
      ` skippedDayBelowThreshold=${skippedDayUnproven} skippedFullyCovered=${skippedCovered}`,
  );

  // ---- per-member effect ---------------------------------------------------
  const byMember = new Map<string, Span[]>();
  for (const s of keep) {
    const list = byMember.get(s.memberId) ?? [];
    list.push(s);
    byMember.set(s.memberId, list);
  }

  let improved = 0;
  for (const [memberId, list] of byMember) {
    const before = dayTotals(existing.get(memberId) ?? []);
    const after = new Map(before);
    for (const s of list) {
      const k = dayKey(toListeningDayWIB(s.startedAt));
      after.set(k, (after.get(k) ?? 0) + s.listenedSec);
    }
    const streakBefore = computeStreak(qualifyingDaysOf(before), today);
    const streakAfter = computeStreak(qualifyingDaysOf(after), today);
    const newDays = [...after.keys()].filter(
      (k) => (after.get(k) ?? 0) >= MIN_QUALIFY_SEC && (before.get(k) ?? 0) < MIN_QUALIFY_SEC,
    );
    if (streakAfter > streakBefore) improved++;
    log(
      `member=${memberId} spans=${list.length} daysRecovered=${newDays.length}` +
        `${newDays.length ? ` [${newDays.join(',')}]` : ''} streak ${streakBefore}→${streakAfter}`,
    );
  }

  if (DRY_RUN) {
    log(`DONE members=${byMember.size} streakImproved=${improved} (nothing written)`);
    await prisma.$disconnect();
    return;
  }

  // ---- write ---------------------------------------------------------------
  let inserted = 0;
  for (const part of chunk(keep, 500)) {
    const res = await prisma.listeningSession.createMany({
      data: part.map((s) => ({
        memberId: s.memberId,
        // Deterministic: a second run of the same CSV collides on
        // (member_id, client_session_id) and is skipped, never duplicated.
        clientSessionId: uuidV5(`${s.memberId}|${s.startedAt.toISOString()}|${s.audioId}`, NAMESPACE),
        audioId: s.audioId,
        courseId: s.courseId,
        startedAt: s.startedAt,
        listenedSec: s.listenedSec,
        completed: s.completed,
        localDay: toListeningDayWIB(s.startedAt),
        source: SOURCE,
      })),
      skipDuplicates: true,
    });
    inserted += res.count;
  }

  log(`DONE members=${byMember.size} inserted=${inserted} skippedAsDuplicate=${keep.length - inserted} streakImproved=${improved}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error('[tracker:backfill] fatal:', e);
  await prisma.$disconnect();
  process.exit(1);
});
