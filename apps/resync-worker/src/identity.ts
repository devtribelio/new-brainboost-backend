/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Member identity fix-up CLI — undo a wrong dedup decision made by migrate-members.ts.
 *
 *   pnpm resync:identity audit
 *   pnpm resync:identity split --loser=541813 [--take=phone] [--leave=email] [--yes]
 *
 * WHY. `migrate-members.ts` clustered legacy members by (email ∨ phone) and picked ONE
 * winner per cluster via `better()`, whose 2nd criterion is `hasEnroll` ("buyer beats
 * non-buyer") — it short-circuits before loginCount / lastActive / verified count. So a
 * dormant account that once bought a brainboost course beats the account the person
 * actually uses. The loser is never inserted; every row it owned (commissions, KYC,
 * downlines) was redirected onto the winner at migration time.
 *
 * `split` materialises the loser as its OWN member and moves back everything whose
 * ownership can be PROVEN from legacy (see §Ownership below). Editing `member_redirect`
 * by hand cannot do this: `Member.legacyId` is never re-pointed, `ensureMember()` calls
 * `create(legacyId)` (not `create(winner)`), and a collision re-writes the redirect row
 * you just deleted (`persistRedirect`).
 *
 * OWNERSHIP. Only rows carrying a legacy origin can be attributed:
 *   AffiliateCommission (legacyId), CourseEnrollment (legacyId), MemberAffiliator
 *   (legacyId), Post/Comment (legacyId), PostLike/CommentLike (no legacyId → re-derived
 *   from the legacy `like` table). KYC / affiliateCode / affiliateBased / inviterId are
 *   re-derived from legacy. Everything created by the NEW app (Device, RefreshToken,
 *   Notification, AffiliateVisit, CommerceTransaction/Payment, AffiliateDisbursement,
 *   TopicSubscription, MemberProfile) carries no legacy origin and is left on the winner
 *   — there is no way to tell which identity used it. The tool reports it and refuses
 *   without --allow-app-data.
 *
 * SAFETY. Never deletes a member (every relation is onDelete: Cascade). Holds the same
 * `sync_state.__lock__` run-lock as the resync so it can't interleave with a syncer.
 * Prints a full before-report and asks for confirmation before writing. Idempotent:
 * re-running after a completed split is a no-op.
 *
 * There is no `merge` (the inverse) — a split cannot be undone by this tool.
 */
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { RowDataPacket } from 'mysql2/promise';
import { normalizePhonePair } from '@bb/common/utils/phone.util';
import { connectLegacyDb } from './legacy-db';
import { acquireLock, releaseLock } from './core';
import { applyKycDecisions } from './syncers/kyc';
import { recountCounters } from './recount';
import { emptyStats, type RunCtx } from './types';
import { bool, nonEmpty, toDate } from './util';
import { resyncConfig } from './config';

type IdentityField = 'email' | 'phone' | 'googleSub' | 'appleSub';
const IDENTITY_FIELDS: IdentityField[] = ['email', 'phone', 'googleSub', 'appleSub'];

function ts() {
  return new Date().toISOString().slice(11, 19);
}
function log(msg: string) {
  console.log(`[${ts()}] [identity] ${msg}`);
}
function idr(n: number) {
  return n.toLocaleString('id-ID');
}
function head(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

// ---------------------------------------------------------------------------
// legacy member → the same shape migrate-members.ts / ensure-member.ts derive
// ---------------------------------------------------------------------------
const MEMBER_COLS = `member_id, email, name, first_name, last_name, phone, password, image_url,
                     biography, is_active, is_email_verified, is_phone_verified, google_id,
                     sign_in_with_apple_id, date_register, is_deleted, login_count, last_active,
                     bank_account_bank, bank_account_number, bank_account_name`;

interface LegacyIdentity {
  memberId: number;
  email: string | null;
  phone: string | null;
  phoneCode: string | null;
  googleSub: string | null;
  appleSub: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isActive: boolean;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  passwordHash: string;
  passwordAlgo: string;
  createdAt: Date;
  bankCode: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  loginCount: number;
  lastActive: Date | null;
  raw: any;
}

function toIdentity(r: any): LegacyIdentity {
  let email = nonEmpty(r.email) ? String(r.email).trim().toLowerCase() : null;
  if (email && /@brainboost\.id$/i.test(email)) email = null; // generated → phone is identity
  const rawPhone = nonEmpty(r.phone);
  const pair = rawPhone ? normalizePhonePair(rawPhone, '+62') : null;
  const phone = pair && pair.phone.length >= 6 ? pair.phone : null;
  const legacyPassword = nonEmpty(r.password);
  return {
    memberId: Number(r.member_id),
    email,
    phone,
    phoneCode: phone ? pair!.phoneCode : null,
    googleSub: nonEmpty(r.google_id),
    appleSub: nonEmpty(r.sign_in_with_apple_id),
    fullName:
      nonEmpty(r.name) ??
      ([nonEmpty(r.first_name), nonEmpty(r.last_name)].filter(Boolean).join(' ') || null),
    avatarUrl: nonEmpty(r.image_url),
    bio: nonEmpty(r.biography),
    isActive: bool(r.is_active) && !bool(r.is_deleted),
    isEmailVerified: email ? bool(r.is_email_verified) : false,
    isPhoneVerified: phone ? bool(r.is_phone_verified) : false,
    passwordHash: legacyPassword ?? `${randomUUID()}${randomUUID()}`,
    passwordAlgo: legacyPassword ? 'legacy' : 'social',
    createdAt: toDate(r.date_register) ?? new Date(),
    bankCode: nonEmpty(r.bank_account_bank),
    bankAccountNumber: nonEmpty(r.bank_account_number),
    bankAccountName: nonEmpty(r.bank_account_name),
    loginCount: Number(r.login_count ?? 0),
    lastActive: toDate(r.last_active),
    raw: r,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
interface MoveSet {
  commissionLegacyIds: number[];
  commissionTotal: number;
  buyerCommissionLegacyIds: number[];
  enrollmentLegacyIds: number[];
  affiliatorLegacyIds: number[];
  postLegacyIds: number[];
  commentLegacyIds: number[];
  postLikeIds: string[]; // bb Post.id whose like row must move
  commentLikeIds: string[]; // bb Comment.id
  downlineMemberIds: string[]; // bb Member.id currently inviterId=winner
}

interface Plan {
  loser: number;
  winner: number;
  legacyLoser: LegacyIdentity;
  legacyWinner: LegacyIdentity;
  winnerMemberId: string;
  winnerMember: any;
  /** field → who currently holds it in bb ('winner' | 'other member legacyId' ) */
  conflicts: { field: IdentityField; value: string; holder: string; takeable: boolean }[];
  decisions: Map<IdentityField, 'take' | 'leave'>;
  move: MoveSet;
  tree: { affiliateCode: string | null; affiliateBased: string; inviterMemberId: string | null };
  kyc: { loserRows: number; winnerRows: number; winnerCurrent: string | null; winnerSource: string | null };
  appData: Record<string, number>;
  blockers: string[];
  warnings: string[];
  alreadyDone: boolean;
}

async function q(legacy: any, sql: string, params: any[] = []): Promise<any[]> {
  const [rows] = (await legacy.query(sql, params)) as [RowDataPacket[], unknown];
  return rows as any[];
}

async function buildPlan(
  prisma: PrismaClient,
  legacy: any,
  loser: number,
  decisions: Map<IdentityField, 'take' | 'leave'>,
): Promise<Plan> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const redirectRow = await prisma.memberRedirect.findUnique({ where: { loserLegacyId: loser } });
  const existingLoser = await prisma.member.findUnique({
    where: { legacyId: loser },
    select: { id: true },
  });
  if (existingLoser && !redirectRow) {
    // nothing left to do — a previous run already split this pair
    log(`legacy ${loser} already exists as its own member (${existingLoser.id}) and holds no redirect row`);
  }
  if (!redirectRow && !existingLoser) blockers.push(`no member_redirect row for loser ${loser} — nothing to split`);
  if (redirectRow && existingLoser) {
    // the split is atomic, so this can only come from elsewhere (a resync ensureMember
    // create raced with a stale redirect row). Needs a human before anything is moved.
    blockers.push(
      `inconsistent state: legacy ${loser} already exists as member ${existingLoser.id} AND still has a redirect row → ${redirectRow.winnerLegacyId}`,
    );
  }
  const winner = redirectRow?.winnerLegacyId ?? 0;

  const [lRow] = await q(legacy, `SELECT ${MEMBER_COLS} FROM member WHERE member_id = ?`, [loser]);
  if (!lRow) blockers.push(`legacy member ${loser} not found`);
  const legacyLoser = lRow ? toIdentity(lRow) : (null as any);
  const [wRow] = winner ? await q(legacy, `SELECT ${MEMBER_COLS} FROM member WHERE member_id = ?`, [winner]) : [];
  const legacyWinner = wRow ? toIdentity(wRow) : (null as any);

  if (legacyLoser && !legacyLoser.email && !legacyLoser.phone && !legacyLoser.googleSub && !legacyLoser.appleSub) {
    blockers.push(`legacy member ${loser} has no usable identity (email/phone/google/apple all empty)`);
  }

  const winnerMember = winner
    ? await prisma.member.findUnique({ where: { legacyId: winner } })
    : null;
  if (winner && !winnerMember) blockers.push(`winner ${winner} is not present in Postgres`);
  const winnerMemberId = winnerMember?.id ?? '';

  // ---- identity conflicts -------------------------------------------------
  const conflicts: Plan['conflicts'] = [];
  if (legacyLoser) {
    for (const f of IDENTITY_FIELDS) {
      const value = legacyLoser[f];
      if (!value) continue;
      const holder = await prisma.member.findFirst({
        where: { [f]: value } as any,
        select: { id: true, legacyId: true },
      });
      if (!holder) continue;
      if (existingLoser && holder.id === existingLoser.id) continue; // already ours
      conflicts.push({
        field: f,
        value,
        holder: holder.legacyId === winner ? 'winner' : `member legacyId=${holder.legacyId ?? '(app)'}`,
        takeable: holder.id === winnerMemberId, // only the winner's own field may be handed over
      });
    }
  }
  for (const c of conflicts) {
    const d = decisions.get(c.field);
    if (!d) {
      blockers.push(
        `identity conflict on "${c.field}" (${c.value}) held by ${c.holder} — pass --take=${c.field} or --leave=${c.field}`,
      );
    } else if (d === 'take' && !c.takeable) {
      blockers.push(`--take=${c.field} refused: "${c.value}" belongs to ${c.holder}, not the winner`);
    }
  }

  // ---- disbursement guard -------------------------------------------------
  if (winnerMemberId) {
    const held = await prisma.affiliateDisbursement.count({
      where: { memberId: winnerMemberId, status: { in: ['PENDING', 'PROCESSING', 'PAID'] } },
    });
    if (held > 0) {
      blockers.push(
        `winner has ${held} disbursement(s) in PENDING/PROCESSING/PAID — moving commissions would change withdrawableBalance`,
      );
    }
  }

  // ---- what moves ---------------------------------------------------------
  const move: MoveSet = {
    commissionLegacyIds: [],
    commissionTotal: 0,
    buyerCommissionLegacyIds: [],
    enrollmentLegacyIds: [],
    affiliatorLegacyIds: [],
    postLegacyIds: [],
    commentLegacyIds: [],
    postLikeIds: [],
    commentLikeIds: [],
    downlineMemberIds: [],
  };
  const tree: Plan['tree'] = { affiliateCode: null, affiliateBased: 'PERFORMANCE', inviterMemberId: null };
  const kyc: Plan['kyc'] = {
    loserRows: 0,
    winnerRows: 0,
    winnerCurrent: winnerMember?.kycStatus ?? null,
    winnerSource: winnerMember?.kycSource ?? null,
  };

  if (legacyLoser && winnerMemberId) {
    // commissions received
    for (const r of await q(
      legacy,
      `SELECT affiliator_commision_id id, price_recipient amt FROM affiliator_commision WHERE member_recipient_id = ?`,
      [loser],
    )) {
      move.commissionLegacyIds.push(Number(r.id));
      move.commissionTotal += Number(r.amt ?? 0);
    }
    // commissions where the loser was the recorded downline
    for (const r of await q(
      legacy,
      `SELECT affiliator_commision_id id FROM affiliator_commision WHERE member_downline_id = ?`,
      [loser],
    )) {
      move.buyerCommissionLegacyIds.push(Number(r.id));
    }
    // enrollments
    for (const r of await q(legacy, `SELECT course_enrollment_id id FROM course_enrollment WHERE member_id = ?`, [loser])) {
      move.enrollmentLegacyIds.push(Number(r.id));
    }
    // program memberships
    for (const r of await q(
      legacy,
      `SELECT mpa.member_product_affiliator_id id
         FROM member_product_affiliator mpa
         JOIN network_account_affiliator naa
           ON naa.network_account_affiliator_id = mpa.network_account_affiliator_id
        WHERE naa.member_id = ?`,
      [loser],
    )) {
      move.affiliatorLegacyIds.push(Number(r.id));
    }
    // posts / comments
    for (const r of await q(legacy, `SELECT post_id id FROM post WHERE member_id = ?`, [loser])) {
      move.postLegacyIds.push(Number(r.id));
    }
    for (const r of await q(legacy, `SELECT comment_id id FROM comment WHERE member_id = ?`, [loser])) {
      move.commentLegacyIds.push(Number(r.id));
    }
    // likes — no legacyId on the bb row, so re-derive; skip any target the WINNER also
    // liked in legacy (migration collapsed both into one row; moving it would silently
    // take the winner's like away).
    const loserLikes = await q(legacy, 'SELECT post_id, comment_id FROM `like` WHERE status=1 AND member_id = ?', [loser]);
    const winnerLikes = await q(legacy, 'SELECT post_id, comment_id FROM `like` WHERE status=1 AND member_id = ?', [winner]);
    const wPosts = new Set(winnerLikes.filter((r) => !r.comment_id).map((r) => Number(r.post_id)));
    const wComments = new Set(winnerLikes.filter((r) => r.comment_id).map((r) => Number(r.comment_id)));
    const postLegacy = loserLikes.filter((r) => !r.comment_id).map((r) => Number(r.post_id)).filter((id) => id && !wPosts.has(id));
    const commentLegacy = loserLikes.filter((r) => r.comment_id).map((r) => Number(r.comment_id)).filter((id) => id && !wComments.has(id));
    const sharedPost = loserLikes.filter((r) => !r.comment_id && wPosts.has(Number(r.post_id))).length;
    const sharedComment = loserLikes.filter((r) => r.comment_id && wComments.has(Number(r.comment_id))).length;
    if (sharedPost || sharedComment) {
      warnings.push(`${sharedPost + sharedComment} like(s) liked by BOTH accounts stay on the winner (one row, two legacy likes)`);
    }
    if (postLegacy.length) {
      for (const p of await prisma.post.findMany({ where: { legacyId: { in: postLegacy } }, select: { id: true } })) {
        move.postLikeIds.push(p.id);
      }
    }
    if (commentLegacy.length) {
      for (const c of await prisma.comment.findMany({ where: { legacyId: { in: commentLegacy } }, select: { id: true } })) {
        move.commentLikeIds.push(c.id);
      }
    }

    // downlines: legacy children of the loser's own network node
    const children = await q(
      legacy,
      `SELECT c.member_id AS member_id
         FROM member_network mine
         JOIN member_network c ON c.parent_id = mine.member_network_id
        WHERE mine.member_id = ?`,
      [loser],
    );
    if (children.length) {
      const childLegacy = children.map((r) => Number(r.member_id));
      // `inviterId: null` counts too — the tree syncer used to wipe the chain when the
      // inviter wasn't materialised yet, so a downline of the loser may currently point
      // at nobody rather than at the winner. Legacy is authoritative for the tree.
      for (const m of await prisma.member.findMany({
        where: {
          legacyId: { in: childLegacy },
          OR: [{ inviterId: winnerMemberId }, { inviterId: null }],
        },
        select: { id: true },
      })) {
        move.downlineMemberIds.push(m.id);
      }
    }

    // the loser's own tree row
    const [own] = await q(
      legacy,
      `SELECT mn.parent_id, mn.affiliate_based, m.affiliator_code
         FROM member_network mn JOIN member m ON m.member_id = mn.member_id
        WHERE mn.member_id = ?`,
      [loser],
    );
    if (own) {
      tree.affiliateBased = nonEmpty(own.affiliate_based) ?? 'PERFORMANCE';
      tree.affiliateCode = nonEmpty(own.affiliator_code);
      if (own.parent_id) {
        const [p] = await q(legacy, `SELECT member_id FROM member_network WHERE member_network_id = ?`, [Number(own.parent_id)]);
        if (p) {
          const inviterLegacy = Number(p.member_id);
          const canonical = (await prisma.memberRedirect.findUnique({ where: { loserLegacyId: inviterLegacy } }))?.winnerLegacyId ?? inviterLegacy;
          const inviter = await prisma.member.findUnique({ where: { legacyId: canonical }, select: { id: true } });
          tree.inviterMemberId = inviter?.id ?? null;
        }
      }
    }
    if (tree.affiliateCode) {
      const codeHolder = await prisma.member.findFirst({
        where: { affiliateCode: tree.affiliateCode },
        select: { id: true, legacyId: true },
      });
      if (codeHolder && codeHolder.id !== existingLoser?.id) {
        warnings.push(`affiliateCode ${tree.affiliateCode} already held by legacyId=${codeHolder.legacyId} — new member gets none`);
        tree.affiliateCode = null;
      }
    }

    // KYC
    kyc.loserRows = Number(
      (await q(legacy, `SELECT COUNT(*) n FROM member_data_kyc WHERE member_id = ? AND kyc_status IN ('APPROVED','REJECTED')`, [loser]))[0]?.n ?? 0,
    );
    kyc.winnerRows = Number(
      (await q(legacy, `SELECT COUNT(*) n FROM member_data_kyc WHERE member_id = ? AND kyc_status IN ('APPROVED','REJECTED')`, [winner]))[0]?.n ?? 0,
    );
    if (kyc.loserRows > 0 && kyc.winnerRows > 0) {
      warnings.push('both accounts have their own legacy KYC — after the split BOTH may end up APPROVED (same person, two identities)');
    }
    if (kyc.loserRows > 0 && kyc.winnerRows === 0) {
      warnings.push(`winner's KYC came from the loser — after the split the winner is re-evaluated and may lose ${kyc.winnerCurrent ?? 'its status'}`);
    }
  }

  // ---- new-app data on the winner ----------------------------------------
  const appData: Record<string, number> = {};
  if (winnerMemberId) {
    const w = { memberId: winnerMemberId };
    appData.devices = await prisma.device.count({ where: w });
    appData.refreshTokens = await prisma.refreshToken.count({ where: w });
    appData.notifications = await prisma.notification.count({ where: w });
    appData.affiliateVisits = await prisma.affiliateVisit.count({ where: { affiliatorMemberId: winnerMemberId } });
    appData.commerceTransactions = await prisma.commerceTransaction.count({ where: w });
    appData.disbursements = await prisma.affiliateDisbursement.count({ where: w });
    appData.topicSubscriptions = await prisma.topicSubscription.count({ where: w });
  }

  return {
    loser,
    winner,
    legacyLoser,
    legacyWinner,
    winnerMemberId,
    winnerMember,
    conflicts,
    decisions,
    move,
    tree,
    kyc,
    appData,
    blockers,
    warnings,
    alreadyDone: Boolean(existingLoser && !redirectRow),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function printPlan(plan: Plan, allowAppData: boolean) {
  const L = plan.legacyLoser;
  const W = plan.legacyWinner;

  head('PAIR');
  console.log(`  loser  (to become its own member) : legacy ${plan.loser}`);
  console.log(`  winner (stays as is)             : legacy ${plan.winner}  → member ${plan.winnerMemberId || '(missing)'}`);

  if (L && W) {
    head('LEGACY IDENTITY');
    console.table([
      {
        who: `loser ${plan.loser}`,
        name: L.fullName,
        email: L.email,
        phone: L.phone,
        google: L.googleSub ? `${L.googleSub.slice(0, 8)}…` : null,
        logins: L.loginCount,
        lastActive: L.lastActive?.toISOString().slice(0, 10) ?? null,
      },
      {
        who: `winner ${plan.winner}`,
        name: W.fullName,
        email: W.email,
        phone: W.phone,
        google: W.googleSub ? `${W.googleSub.slice(0, 8)}…` : null,
        logins: W.loginCount,
        lastActive: W.lastActive?.toISOString().slice(0, 10) ?? null,
      },
    ]);
  }

  if (plan.winnerMember) {
    head('WINNER IN POSTGRES (before)');
    const m = plan.winnerMember;
    console.table([
      {
        id: `${m.id.slice(0, 8)}…`,
        email: m.email,
        phone: m.phone,
        affiliateCode: m.affiliateCode,
        based: m.affiliateBased,
        kyc: `${m.kycStatus}/${m.kycSource}`,
        active: m.isActive,
      },
    ]);
  }

  head('IDENTITY CONFLICTS');
  if (!plan.conflicts.length) console.log('  (none — every identity field of the loser is free)');
  for (const c of plan.conflicts) {
    const d = plan.decisions.get(c.field);
    const verdict = d === 'take' ? '→ TAKE (cleared on winner, set on new member)' : d === 'leave' ? '→ LEAVE (new member gets none)' : '→ UNDECIDED';
    console.log(`  ${c.field.padEnd(10)} ${String(c.value).padEnd(32)} held by ${c.holder.padEnd(22)} ${verdict}`);
  }

  head('DATA THAT MOVES TO THE NEW MEMBER');
  const mv = plan.move;
  console.table([
    { what: 'AffiliateCommission (recipient)', rows: mv.commissionLegacyIds.length, note: `Rp ${idr(mv.commissionTotal)}` },
    { what: 'AffiliateCommission (buyerMemberId)', rows: mv.buyerCommissionLegacyIds.length, note: '' },
    { what: 'CourseEnrollment', rows: mv.enrollmentLegacyIds.length, note: '' },
    { what: 'MemberAffiliator', rows: mv.affiliatorLegacyIds.length, note: '' },
    { what: 'Post (author)', rows: mv.postLegacyIds.length, note: '' },
    { what: 'Comment (author)', rows: mv.commentLegacyIds.length, note: '' },
    { what: 'PostLike', rows: mv.postLikeIds.length, note: '' },
    { what: 'CommentLike', rows: mv.commentLikeIds.length, note: '' },
    { what: 'Downline inviterId re-point', rows: mv.downlineMemberIds.length, note: '' },
  ]);

  head('NEW MEMBER WILL BE CREATED WITH');
  const d = plan.decisions;
  const take = (f: IdentityField) => {
    const c = plan.conflicts.find((x) => x.field === f);
    if (c && d.get(f) !== 'take') return null;
    return L ? L[f] : null;
  };
  console.table([
    {
      legacyId: plan.loser,
      email: take('email'),
      phone: take('phone'),
      google: take('googleSub') ? `${String(take('googleSub')).slice(0, 8)}…` : null,
      affiliateCode: plan.tree.affiliateCode,
      based: plan.tree.affiliateBased,
      inviter: plan.tree.inviterMemberId ? `${plan.tree.inviterMemberId.slice(0, 8)}…` : null,
    },
  ]);

  head('KYC');
  console.log(`  legacy KYC rows — loser: ${plan.kyc.loserRows}, winner: ${plan.kyc.winnerRows}`);
  console.log(`  winner currently: ${plan.kyc.winnerCurrent}/${plan.kyc.winnerSource} (both members get re-evaluated from their OWN rows)`);

  head('STAYS ON THE WINNER (new-app data, no legacy origin)');
  console.table([plan.appData]);

  if (plan.warnings.length) {
    head('WARNINGS');
    for (const w of plan.warnings) console.log(`  ! ${w}`);
  }

  const appTotal = Object.values(plan.appData).reduce((a, b) => a + b, 0);
  if (appTotal > 0 && !allowAppData) {
    plan.blockers.push(`winner holds ${appTotal} new-app row(s) that cannot be attributed — pass --allow-app-data to accept leaving them`);
  }

  if (plan.blockers.length) {
    head('BLOCKERS');
    for (const b of plan.blockers) console.log(`  ✗ ${b}`);
  }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
async function executeSplit(prisma: PrismaClient, legacy: any, plan: Plan): Promise<string> {
  const L = plan.legacyLoser;
  const d = plan.decisions;
  const takes = plan.conflicts.filter((c) => d.get(c.field) === 'take').map((c) => c.field);
  const value = (f: IdentityField): string | null => {
    const conflicted = plan.conflicts.some((c) => c.field === f);
    if (conflicted && !takes.includes(f)) return null;
    return L[f];
  };

  const newId = await prisma.$transaction(async (tx) => {
    // 1. free every field we are taking over — must happen before the insert
    if (takes.length) {
      const clear: any = {};
      for (const f of takes) {
        clear[f] = null;
        if (f === 'phone') {
          clear.phoneCode = null;
          clear.isPhoneVerified = false;
        }
        if (f === 'email') clear.isEmailVerified = false;
      }
      await tx.member.update({ where: { id: plan.winnerMemberId }, data: clear });
    }

    // 2. create the loser as its own member
    const now = new Date();
    const email = value('email');
    const phone = value('phone');
    const created = await tx.member.create({
      data: {
        legacyId: plan.loser,
        email,
        phone,
        phoneCode: phone ? L.phoneCode : null,
        googleSub: value('googleSub'),
        appleSub: value('appleSub'),
        fullName: L.fullName,
        avatarUrl: L.avatarUrl,
        bio: L.bio,
        isActive: L.isActive,
        isEmailVerified: email ? L.isEmailVerified : false,
        isPhoneVerified: phone ? L.isPhoneVerified : false,
        passwordHash: L.passwordHash,
        passwordAlgo: L.passwordAlgo,
        bankCode: L.bankAccountNumber ? L.bankCode : null,
        bankAccountNumber: L.bankAccountNumber,
        bankAccountName: L.bankAccountNumber ? L.bankAccountName : null,
        affiliateCode: plan.tree.affiliateCode,
        affiliateBased: plan.tree.affiliateBased,
        inviterId: plan.tree.inviterMemberId,
        createdAt: L.createdAt,
        legacySyncedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });

    // 3. drop the redirect row — after this the loser resolves to itself
    await tx.memberRedirect.deleteMany({ where: { loserLegacyId: plan.loser } });

    // 4. move everything whose ownership is provable from legacy
    const mv = plan.move;
    const chunk = <T,>(a: T[], n = 1000) => {
      const out: T[][] = [];
      for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
      return out;
    };
    for (const ids of chunk(mv.commissionLegacyIds)) {
      await tx.affiliateCommission.updateMany({
        where: { legacyId: { in: ids }, recipientId: plan.winnerMemberId },
        data: { recipientId: created.id },
      });
    }
    for (const ids of chunk(mv.buyerCommissionLegacyIds)) {
      await tx.affiliateCommission.updateMany({
        where: { legacyId: { in: ids }, buyerMemberId: plan.winnerMemberId },
        data: { buyerMemberId: created.id },
      });
    }
    for (const ids of chunk(mv.enrollmentLegacyIds)) {
      await tx.courseEnrollment.updateMany({
        where: { legacyId: { in: ids }, memberId: plan.winnerMemberId },
        data: { memberId: created.id },
      });
    }
    for (const ids of chunk(mv.affiliatorLegacyIds)) {
      await tx.memberAffiliator.updateMany({
        where: { legacyId: { in: ids }, memberId: plan.winnerMemberId },
        data: { memberId: created.id },
      });
    }
    for (const ids of chunk(mv.postLegacyIds)) {
      await tx.post.updateMany({ where: { legacyId: { in: ids }, authorId: plan.winnerMemberId }, data: { authorId: created.id } });
    }
    for (const ids of chunk(mv.commentLegacyIds)) {
      await tx.comment.updateMany({ where: { legacyId: { in: ids }, authorId: plan.winnerMemberId }, data: { authorId: created.id } });
    }
    for (const ids of chunk(mv.postLikeIds)) {
      await tx.postLike.updateMany({ where: { postId: { in: ids }, memberId: plan.winnerMemberId }, data: { memberId: created.id } });
    }
    for (const ids of chunk(mv.commentLikeIds)) {
      await tx.commentLike.updateMany({ where: { commentId: { in: ids }, memberId: plan.winnerMemberId }, data: { memberId: created.id } });
    }
    for (const ids of chunk(mv.downlineMemberIds)) {
      await tx.member.updateMany({
        where: { id: { in: ids }, OR: [{ inviterId: plan.winnerMemberId }, { inviterId: null }] },
        data: { inviterId: created.id },
      });
    }
    return created.id;
  });

  log(`new member created: ${newId} (legacyId=${plan.loser})`);

  // 5. re-evaluate KYC for BOTH members from their own legacy rows. Runs outside the
  //    transaction: applyKycDecisions is guarded (kycSource NONE/LEGACY) and idempotent,
  //    and it needs the post-split redirect/member maps.
  const redirect = new Map<number, number>();
  for (const r of await prisma.memberRedirect.findMany({ select: { loserLegacyId: true, winnerLegacyId: true } })) {
    redirect.set(r.loserLegacyId, r.winnerLegacyId);
  }
  const memberByLegacy = new Map<number, string>();
  for (const m of await prisma.member.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
    if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
  }
  const ctx: RunCtx = {
    prisma,
    legacy,
    redirect,
    memberByLegacy,
    resolveMember: (id) => (id == null ? undefined : memberByLegacy.get(redirect.get(id) ?? id)),
    ensureMember: async (id) => (id == null ? undefined : memberByLegacy.get(redirect.get(id) ?? id)),
    batchSize: resyncConfig.batchSize,
    dryRun: false,
    log,
  } as RunCtx;
  const kycStats = emptyStats();
  await applyKycDecisions(ctx, [plan.loser, plan.winner], kycStats);
  log(`kyc re-evaluated: upserted=${kycStats.upserted} skipped=${kycStats.skipped}`);

  // 6. post/comment/like counters are denormalised → recompute
  await recountCounters(prisma, log);

  return newId;
}

async function printAfter(prisma: PrismaClient, plan: Plan, newId: string) {
  head('AFTER');
  const rows = await prisma.member.findMany({
    where: { legacyId: { in: [plan.loser, plan.winner] } },
    select: {
      id: true,
      legacyId: true,
      email: true,
      phone: true,
      affiliateCode: true,
      affiliateBased: true,
      kycStatus: true,
      kycSource: true,
      inviterId: true,
    },
  });
  const enriched = [];
  for (const m of rows) {
    enriched.push({
      legacyId: m.legacyId,
      email: m.email,
      phone: m.phone,
      code: m.affiliateCode,
      based: m.affiliateBased,
      kyc: `${m.kycStatus}/${m.kycSource}`,
      commissions: await prisma.affiliateCommission.count({ where: { recipientId: m.id } }),
      amount: idr(
        (await prisma.affiliateCommission.aggregate({ where: { recipientId: m.id }, _sum: { amount: true } }))._sum.amount ?? 0,
      ),
      downlines: await prisma.member.count({ where: { inviterId: m.id } }),
    });
  }
  console.table(enriched);
  console.log(`  new member id: ${newId}`);
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------
async function runAudit(prisma: PrismaClient, legacy: any) {
  const pairs = await prisma.memberRedirect.findMany({ select: { loserLegacyId: true, winnerLegacyId: true } });
  if (!pairs.length) {
    log('member_redirect is empty — run resync:seed-redirect first');
    return;
  }
  const ids = [...new Set(pairs.flatMap((p) => [p.loserLegacyId, p.winnerLegacyId]))];
  const info = new Map<number, any>();
  for (const r of await q(legacy, `SELECT member_id, login_count, last_active FROM member WHERE member_id IN (?)`, [ids])) {
    info.set(Number(r.member_id), r);
  }
  const comm = new Map<number, number>();
  for (const r of await q(
    legacy,
    `SELECT member_recipient_id m, SUM(price_recipient) total FROM affiliator_commision WHERE member_recipient_id IN (?) GROUP BY m`,
    [ids],
  )) {
    comm.set(Number(r.m), Number(r.total ?? 0));
  }
  const dl = new Map<number, number>();
  for (const r of await q(
    legacy,
    `SELECT mine.member_id m, COUNT(*) n FROM member_network mine
       JOIN member_network c ON c.parent_id = mine.member_network_id
      WHERE mine.member_id IN (?) GROUP BY m`,
    [ids],
  )) {
    dl.set(Number(r.m), Number(r.n));
  }

  const suspects = [];
  for (const { loserLegacyId: loser, winnerLegacyId: winner } of pairs) {
    const L = info.get(loser);
    const W = info.get(winner);
    if (!L || !W) continue;
    const lLogin = Number(L.login_count ?? 0);
    const wLogin = Number(W.login_count ?? 0);
    const lAct = L.last_active ? new Date(L.last_active).getTime() : 0;
    const wAct = W.last_active ? new Date(W.last_active).getTime() : 0;
    const lC = comm.get(loser) ?? 0;
    const wC = comm.get(winner) ?? 0;
    const activityWorse = lLogin > wLogin && lAct > wAct;
    const moneyWorse = lC > wC;
    if (!activityWorse && !moneyWorse) continue;
    suspects.push({
      loser,
      winner,
      logins: `${lLogin} / ${wLogin}`,
      commission: `${idr(lC)} / ${idr(wC)}`,
      downlines: `${dl.get(loser) ?? 0} / ${dl.get(winner) ?? 0}`,
      reason: [activityWorse && 'more active', moneyWorse && 'earned more'].filter(Boolean).join(' + '),
    });
  }
  suspects.sort((a, b) => (comm.get(b.loser) ?? 0) - (comm.get(a.loser) ?? 0));
  head(`AUDIT — ${suspects.length} suspect pair(s) of ${pairs.length} (loser/winner)`);
  console.table(suspects);
  console.log('\n  split one with:  pnpm resync:identity split --loser=<id>');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() === 'SPLIT';
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'audit';
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const has = (name: string) => argv.includes(`--${name}`);

  const prisma = new PrismaClient({ log: ['warn', 'error'] });
  const legacy = await connectLegacyDb({ dateStrings: false });
  let lock: Date | null = null;
  try {
    if (cmd === 'audit') {
      await runAudit(prisma, legacy);
      return;
    }
    if (cmd !== 'split') {
      console.error(`unknown command "${cmd}" — expected: audit | split`);
      process.exitCode = 1;
      return;
    }

    const loser = Number(flag('loser'));
    if (!Number.isInteger(loser) || loser <= 0) {
      console.error('usage: pnpm resync:identity split --loser=<legacyId> [--take=phone,email] [--leave=...] [--allow-app-data] [--yes]');
      process.exitCode = 1;
      return;
    }
    const decisions = new Map<IdentityField, 'take' | 'leave'>();
    for (const f of (flag('take') ?? '').split(',').filter(Boolean)) decisions.set(f as IdentityField, 'take');
    for (const f of (flag('leave') ?? '').split(',').filter(Boolean)) decisions.set(f as IdentityField, 'leave');

    // the lock keeps a concurrent resync from writing the same columns mid-split
    lock = await acquireLock(prisma);
    if (!lock) {
      console.error('another resync run holds the lock — try again later (or pnpm resync:unlock if it is stale)');
      process.exitCode = 1;
      return;
    }

    const plan = await buildPlan(prisma, legacy, loser, decisions);
    if (plan.alreadyDone) {
      log(`legacy ${loser} is already its own member — nothing to do`);
      return;
    }
    printPlan(plan, has('allow-app-data'));

    if (plan.blockers.length) {
      console.log('\nrefusing to proceed — resolve the blockers above.');
      process.exitCode = 1;
      return;
    }

    if (!has('yes')) {
      console.log('');
      const ok = await confirm(`Type SPLIT to apply (anything else aborts): `);
      if (!ok) {
        console.log('aborted — nothing was written.');
        return;
      }
    }

    const newId = await executeSplit(prisma, legacy, plan);
    await printAfter(prisma, plan, newId);
    console.log('\ndone.');
  } finally {
    if (lock) await releaseLock(prisma, lock);
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[identity] fatal', err);
  process.exit(1);
});
