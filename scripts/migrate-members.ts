/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Scoped member + enrollment migration: legacy MariaDB -> new Postgres.
 *
 *   pnpm tsx scripts/migrate-members.ts [--dry-run]
 *
 * Full rationale + decisions: docs/specs/member-migration-plan.md. Summary:
 *   SCOPE  = enrolled-in-brainboost ∪ BB-commission-recipients ∪ upline-closure
 *            ∪ valid-downlines-of-in-scope (Tier 2). ≈ 57.6k of 701k.
 *   FILTER = drop junk (@example.com, lxbfYeaa bot) + no-identity. `@brainboost.id`
 *            generated emails → email=null (phone is identity).
 *   DEDUP  = union-find over (email ∨ phone); one winner per cluster (§5 ranking);
 *            losers drop, their enrollments merge to the winner. A redirect map
 *            (loser legacyId -> winner legacyId) is written to scripts/member-redirect.json
 *            so backfill-affiliate-tree can re-point dangling inviter links.
 *   MEMBER = isActive = is_active AND NOT is_deleted (NOT the buggy status=1 gate).
 *   ENROLL = access by payment SUCCESS (course OR bundle) or free; skip FAILED;
 *            dateStart=created (date_start is null in legacy); dedup (member,course).
 *
 * Balance / programs / member_affiliators are NOT touched here (separate steps).
 * Idempotent-ish: keyed by legacyId; re-run after a clean-slate of members +
 * course_enrollment. Writes only `members` and `course_enrollment`.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { normalizePhonePair } from '@bb/common/utils/phone.util';
import { connectLegacyDb } from './legacy-db';

const REDIRECT_PATH = 'scripts/member-redirect.json';
const INSERT_CHUNK = 1000;

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const dryRun = process.argv.includes('--dry-run');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [migrate-members] ${msg}`);
}
function nonEmpty(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function bool(v: any): boolean {
  return v === 1 || v === true || v === '1';
}
function toDate(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const BB_COURSES = `course_id IN (SELECT course_id FROM course WHERE client = 'brainboost')`;

// ---------------------------------------------------------------------------
// 1. Scope
// ---------------------------------------------------------------------------
interface Scope {
  ids: number[];
  enrolled: Set<number>; // for winner ranking (has BB enrollment)
  inviterOf: Map<number, number>; // member_id -> inviter member_id
}

async function buildScope(legacy: Connection): Promise<Scope> {
  const enrolled = new Set<number>();
  const [enr] = await legacy.query<RowDataPacket[]>(
    `SELECT DISTINCT member_id FROM course_enrollment WHERE ${BB_COURSES} AND member_id IS NOT NULL`,
  );
  for (const r of enr as any[]) enrolled.add(Number(r.member_id));

  const base = new Set<number>(enrolled);
  const [rec] = await legacy.query<RowDataPacket[]>(
    `SELECT DISTINCT member_recipient_id m FROM affiliator_commision
      WHERE product_model LIKE '%Course%' AND ${BB_COURSES.replace('course_id', 'product_id')}
        AND member_recipient_id IS NOT NULL`,
  );
  for (const r of rec as any[]) base.add(Number(r.m));

  // member_network: node -> member, member -> inviter member
  const node2member = new Map<number, number>();
  const [allNodes] = await legacy.query<RowDataPacket[]>(
    'SELECT member_network_id, member_id FROM member_network',
  );
  for (const n of allNodes as any[]) node2member.set(Number(n.member_network_id), Number(n.member_id));

  const inviterOf = new Map<number, number>();
  const [parented] = await legacy.query<RowDataPacket[]>(
    'SELECT member_id, parent_id FROM member_network WHERE parent_id IS NOT NULL AND parent_id > 0',
  );
  for (const n of parented as any[]) {
    const inv = node2member.get(Number(n.parent_id));
    if (inv) inviterOf.set(Number(n.member_id), inv);
  }

  // Tier 1: base + upline closure
  const scope = new Set<number>(base);
  for (const m of base) {
    let cur = inviterOf.get(m);
    let depth = 0;
    while (cur && depth < 10) {
      scope.add(cur);
      cur = inviterOf.get(cur);
      depth += 1;
    }
  }
  // Tier 2: downlines whose inviter is in base
  for (const [m, inv] of inviterOf) {
    if (!scope.has(m) && base.has(inv)) scope.add(m);
  }

  log(`scope: enrolled=${enrolled.size} base=${base.size} total(T1+T2)=${scope.size}`);
  return { ids: [...scope], enrolled, inviterOf };
}

// ---------------------------------------------------------------------------
// 2. Fetch + filter members
// ---------------------------------------------------------------------------
interface LegacyMember {
  memberId: number;
  email: string | null; // already lowercased; null for generated/empty
  phone: string | null; // canonical +62; null if absent/invalid
  phoneCode: string | null;
  googleSub: string | null;
  appleSub: string | null;
  fullName: string | null;
  passwordHash: string;
  passwordAlgo: string;
  avatarUrl: string | null;
  bio: string | null;
  bankCode: string | null; // legacy member.bank_account_bank (rarely filled; KYC bank rides resync kyc)
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  createdAt: Date;
  // ranking signals
  isDeleted: boolean;
  loginCount: number;
  lastActive: number; // epoch ms, 0 if null
  hasEnroll: boolean;
}

function isJunk(name: string | null, rawEmail: string | null): boolean {
  if (rawEmail && /@example\.com$/i.test(rawEmail)) return true;
  if (name && /^lxbfYeaa/i.test(name)) return true;
  return false;
}

async function fetchMembers(legacy: Connection, scope: Scope): Promise<LegacyMember[]> {
  const out: LegacyMember[] = [];
  let dropJunk = 0;
  let dropNoId = 0;
  const ids = scope.ids;
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT member_id, email, name, first_name, last_name, phone, password, image_url,
              biography, is_active, is_email_verified, is_phone_verified, google_id,
              sign_in_with_apple_id, date_register, is_deleted, login_count, last_active,
              bank_account_bank, bank_account_number, bank_account_name
         FROM member WHERE member_id IN (?)`,
      [chunk],
    );
    for (const r of rows as any[]) {
      const rawEmail = nonEmpty(r.email);
      if (isJunk(nonEmpty(r.name), rawEmail)) {
        dropJunk += 1;
        continue;
      }
      // Email rule
      let email = rawEmail ? rawEmail.toLowerCase() : null;
      if (email && /@brainboost\.id$/i.test(email)) email = null; // generated → phone identity

      const rawPhone = nonEmpty(r.phone);
      const pair = rawPhone ? normalizePhonePair(rawPhone, '+62') : null;
      const phone = pair && pair.phone.length >= 6 ? pair.phone : null;

      const googleSub = nonEmpty(r.google_id);
      const appleSub = nonEmpty(r.sign_in_with_apple_id);

      // Identity gate
      if (!email && !phone && !googleSub && !appleSub) {
        dropNoId += 1;
        continue;
      }

      const legacyPassword = nonEmpty(r.password);
      const fullName =
        nonEmpty(r.name) ??
        ([nonEmpty(r.first_name), nonEmpty(r.last_name)].filter(Boolean).join(' ') || null);

      out.push({
        memberId: Number(r.member_id),
        email,
        phone,
        phoneCode: phone ? pair!.phoneCode : null,
        googleSub,
        appleSub,
        fullName,
        passwordHash: legacyPassword ?? `${randomUUID()}${randomUUID()}`,
        passwordAlgo: legacyPassword ? 'legacy' : 'social',
        avatarUrl: nonEmpty(r.image_url),
        bio: nonEmpty(r.biography),
        bankCode: nonEmpty(r.bank_account_bank),
        bankAccountNumber: nonEmpty(r.bank_account_number),
        bankAccountName: nonEmpty(r.bank_account_name),
        isActive: bool(r.is_active) && !bool(r.is_deleted),
        isEmailVerified: email ? bool(r.is_email_verified) : false,
        isPhoneVerified: phone ? bool(r.is_phone_verified) : false,
        createdAt: toDate(r.date_register) ?? new Date(),
        isDeleted: bool(r.is_deleted),
        loginCount: Number(r.login_count ?? 0),
        lastActive: toDate(r.last_active)?.getTime() ?? 0,
        hasEnroll: scope.enrolled.has(Number(r.member_id)),
      });
    }
  }
  log(`members fetched=${out.length} dropJunk=${dropJunk} dropNoIdentity=${dropNoId}`);
  return out;
}

// ---------------------------------------------------------------------------
// 3. Union-find dedup + winner
// ---------------------------------------------------------------------------
class DSU {
  private p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b);
  }
}

/** true if `a` is a better winner than `b`. */
function better(a: LegacyMember, b: LegacyMember): boolean {
  if (a.isDeleted !== b.isDeleted) return !a.isDeleted; // live beats deleted
  if (a.hasEnroll !== b.hasEnroll) return a.hasEnroll; // buyer beats non-buyer
  if (a.loginCount !== b.loginCount) return a.loginCount > b.loginCount;
  if (a.lastActive !== b.lastActive) return a.lastActive > b.lastActive;
  const av = (a.isEmailVerified ? 1 : 0) + (a.isPhoneVerified ? 1 : 0);
  const bv = (b.isEmailVerified ? 1 : 0) + (b.isPhoneVerified ? 1 : 0);
  if (av !== bv) return av > bv;
  const aAuth = a.passwordAlgo !== 'social' || !!a.googleSub || !!a.appleSub;
  const bAuth = b.passwordAlgo !== 'social' || !!b.googleSub || !!b.appleSub;
  if (aAuth !== bAuth) return aAuth;
  if (a.createdAt.getTime() !== b.createdAt.getTime())
    return a.createdAt.getTime() < b.createdAt.getTime(); // earliest
  return a.memberId < b.memberId;
}

interface DedupResult {
  winners: LegacyMember[];
  redirect: Map<number, number>; // loser legacyId -> winner legacyId
}

function dedup(members: LegacyMember[]): DedupResult {
  const dsu = new DSU(members.length);
  const byEmail = new Map<string, number>();
  const byPhone = new Map<string, number>();
  members.forEach((m, i) => {
    if (m.email) {
      const e = byEmail.get(m.email);
      if (e !== undefined) dsu.union(i, e);
      else byEmail.set(m.email, i);
    }
    if (m.phone) {
      const p = byPhone.get(m.phone);
      if (p !== undefined) dsu.union(i, p);
      else byPhone.set(m.phone, i);
    }
  });

  const clusters = new Map<number, number[]>();
  members.forEach((_, i) => {
    const root = dsu.find(i);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(i);
  });

  const winners: LegacyMember[] = [];
  const redirect = new Map<number, number>();
  for (const idxs of clusters.values()) {
    let win = idxs[0];
    for (const i of idxs) if (better(members[i], members[win])) win = i;
    winners.push(members[win]);
    for (const i of idxs) {
      if (i !== win) redirect.set(members[i].memberId, members[win].memberId);
    }
  }
  log(`dedup: clusters=${clusters.size} winners=${winners.length} losers=${redirect.size}`);
  return { winners, redirect };
}

// ---------------------------------------------------------------------------
// 4. Insert members
// ---------------------------------------------------------------------------
async function insertMembers(winners: LegacyMember[]): Promise<void> {
  // dedup unique sub fields across winners (email/phone already unique by cluster)
  const seenGoogle = new Set<string>();
  const seenApple = new Set<string>();
  const data = winners.map((w) => {
    let googleSub = w.googleSub;
    if (googleSub && seenGoogle.has(googleSub)) googleSub = null;
    else if (googleSub) seenGoogle.add(googleSub);
    let appleSub = w.appleSub;
    if (appleSub && seenApple.has(appleSub)) appleSub = null;
    else if (appleSub) seenApple.add(appleSub);
    return {
      legacyId: w.memberId,
      email: w.email,
      phone: w.phone,
      phoneCode: w.phoneCode,
      googleSub,
      appleSub,
      fullName: w.fullName,
      passwordHash: w.passwordHash,
      passwordAlgo: w.passwordAlgo,
      avatarUrl: w.avatarUrl,
      bio: w.bio,
      bankCode: w.bankCode,
      bankAccountNumber: w.bankAccountNumber,
      bankAccountName: w.bankAccountName,
      isActive: w.isActive,
      isEmailVerified: w.isEmailVerified,
      isPhoneVerified: w.isPhoneVerified,
      createdAt: w.createdAt,
    };
  });
  let inserted = 0;
  for (let i = 0; i < data.length; i += INSERT_CHUNK) {
    const res = await prisma.member.createMany({
      data: data.slice(i, i + INSERT_CHUNK),
      skipDuplicates: true,
    });
    inserted += res.count;
  }
  log(`members inserted=${inserted}`);
}

// ---------------------------------------------------------------------------
// 5. Migrate enrollments
// ---------------------------------------------------------------------------
async function migrateEnrollments(
  legacy: Connection,
  redirect: Map<number, number>,
  winners: LegacyMember[],
): Promise<void> {
  // legacy course_id -> new Course.id
  const courses = await prisma.course.findMany({
    where: { legacyCourseId: { not: null } },
    select: { id: true, legacyCourseId: true },
  });
  const courseByLegacy = new Map<number, string>();
  for (const c of courses) if (c.legacyCourseId !== null) courseByLegacy.set(c.legacyCourseId, c.id);

  // Valid winner legacyIds (the members that exist / will exist after insert).
  const winnerSet = new Set<number>(winners.map((w) => w.memberId));

  // new Member.id by legacyId — only populated in a real run (members inserted).
  // In dry-run the map is empty; we still validate membership via winnerSet and use a
  // placeholder uuid so the (member,course) dedup + candidate count stay meaningful.
  const memberByLegacy = new Map<number, string>();
  if (!dryRun) {
    const members = await prisma.member.findMany({
      where: { legacyId: { not: null } },
      select: { id: true, legacyId: true },
    });
    for (const m of members) if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
  }

  // Paid/free brainboost enrollments (access rule §6b)
  const [rows] = await legacy.query<RowDataPacket[]>(
    `SELECT e.course_enrollment_id, e.member_id, e.course_id, e.created, e.expired_date,
            e.certificate_code, e.certificate_created, e.progress,
            cp.payment_status AS course_ps, bp.payment_status AS bundle_ps
       FROM course_enrollment e
       LEFT JOIN course_payment cp ON cp.course_payment_id = e.course_payment_id
       LEFT JOIN product_bundle_payment_detail bd
              ON bd.product_bundle_payment_detail_id = e.product_bundle_payment_detail_id
       LEFT JOIN product_bundle_payment bp ON bp.product_bundle_payment_id = bd.product_bundle_payment_id
      WHERE e.${BB_COURSES} AND e.member_id IS NOT NULL`,
  );

  const seenPair = new Set<string>(); // `${memberUuid}|${courseUuid}`
  const data: any[] = [];
  let skipNoAccess = 0;
  let skipNoMap = 0;
  let skipDupPair = 0;
  for (const r of rows as any[]) {
    const access =
      r.course_ps === 'SUCCESS' || r.bundle_ps === 'SUCCESS' || (r.course_ps == null && r.bundle_ps == null);
    if (!access) {
      skipNoAccess += 1;
      continue;
    }
    const legacyMember = Number(r.member_id);
    const winnerLegacy = redirect.get(legacyMember) ?? legacyMember;
    const courseId = courseByLegacy.get(Number(r.course_id));
    // Valid iff the (redirected) member is a winner and the course was migrated.
    if (!winnerSet.has(winnerLegacy) || !courseId) {
      skipNoMap += 1; // member dropped (junk/no-id) or course not migrated
      continue;
    }
    const memberId = dryRun ? `dry-${winnerLegacy}` : memberByLegacy.get(winnerLegacy);
    if (!memberId) {
      skipNoMap += 1;
      continue;
    }
    const key = `${memberId}|${courseId}`;
    if (seenPair.has(key)) {
      skipDupPair += 1;
      continue;
    }
    seenPair.add(key);
    data.push({
      legacyId: Number(r.course_enrollment_id),
      memberId,
      courseId,
      dateStart: toDate(r.created),
      expiredDate: toDate(r.expired_date),
      certificateCode: nonEmpty(r.certificate_code),
      certificateCreated: toDate(r.certificate_created),
      progress: Number(r.progress ?? 0) || 0,
    });
  }

  let inserted = 0;
  if (!dryRun) {
    for (let i = 0; i < data.length; i += INSERT_CHUNK) {
      const res = await prisma.courseEnrollment.createMany({
        data: data.slice(i, i + INSERT_CHUNK),
        skipDuplicates: true,
      });
      inserted += res.count;
    }
  }
  log(
    `enrollments: candidates=${data.length} inserted=${dryRun ? '(dry)' : inserted} ` +
      `skipNoAccess=${skipNoAccess} skipNoMap=${skipNoMap} skipDupPair=${skipDupPair}`,
  );
}

// ---------------------------------------------------------------------------
async function main() {
  if (dryRun) log('DRY RUN — no writes to Postgres / redirect file');
  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');
  try {
    const scope = await buildScope(legacy);
    const members = await fetchMembers(legacy, scope);
    const { winners, redirect } = dedup(members);

    if (dryRun) {
      for (const w of winners.slice(0, 3))
        log(`sample winner legacyId=${w.memberId} email=${w.email ?? '(null)'} phone=${w.phone ? 'set' : 'none'} isActive=${w.isActive}`);
      // enrollment dry pass (no write) to report counts
      await migrateEnrollments(legacy, redirect, winners);
      log(`DONE (dry-run) winners=${winners.length} redirect=${redirect.size}`);
      return;
    }

    await insertMembers(winners);
    writeFileSync(REDIRECT_PATH, `${JSON.stringify(Object.fromEntries(redirect), null, 0)}\n`);
    log(`redirect map written: ${REDIRECT_PATH} (${redirect.size} entries)`);
    await migrateEnrollments(legacy, redirect, winners);
    log(`DONE winners=${winners.length} redirect=${redirect.size}`);
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
