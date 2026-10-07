/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-off correction of the redirect-collapse inviter rows found by the audit (PRD §5 /
 * audit 03). Target rows are a verified whitelist (./inviter-correction-rules.ts).
 *
 *   pnpm repair:inviter                 # dry run (default)
 *   pnpm repair:inviter --apply
 *
 * The tree syncer's self/cycle guard already fixes 424829 / 409824 on a forced rescan, but it
 * can never fix 641123 (one half of a mutual cycle — the guard refuses to write a cycle) nor
 * 390754 (its inviter was set by the app, inviter_source='APP', so the tree never overwrites
 * it). This script handles all four deterministically and prints each row's legacy parent
 * chain so the operator can re-verify before --apply.
 *
 * After --apply, run a full tree rescan so the corrected uplines propagate to downlines:
 *   pnpm resync tree --dry-run --since=1970-01-01T00:00:00Z
 *   pnpm resync tree --since=1970-01-01T00:00:00Z
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { RowDataPacket } from 'mysql2/promise';
import { connectResilientLegacy, type LegacyClient } from './legacy-db';
import { resyncConfig } from './config';
import { acquireLock, releaseLock } from './core';
import { CYCLE_CHECK_LEVELS } from './syncers/inviter-rules';
import { INVITER_CORRECTIONS, planInviterCorrection } from './inviter-correction-rules';

const APPLY = process.argv.includes('--apply');
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] [repair:inviter] ${msg}`);

const prisma = new PrismaClient({ log: ['warn', 'error'] });

/** True when `candidateId`'s 4-level inviter chain reaches `subjectId` (would close a cycle). */
async function wouldCloseCycle(subjectId: string, candidateId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ inviterId: string | null }>>`
    WITH RECURSIVE up AS (
      SELECT inviter_id, 1 AS lvl FROM members WHERE id = ${candidateId}::uuid
      UNION ALL
      SELECT m.inviter_id, up.lvl + 1 FROM members m JOIN up ON m.id = up.inviter_id
       WHERE up.lvl < ${CYCLE_CHECK_LEVELS}
    )
    SELECT inviter_id::text AS "inviterId" FROM up ORDER BY lvl`;
  return rows
    .slice(0, CYCLE_CHECK_LEVELS)
    .some((r) => r.inviterId === subjectId);
}

/** Legacy member id of `memberId`'s newest member_network parent node, or null. */
async function legacyParentMember(legacy: LegacyClient, memberId: number): Promise<number | null> {
  const [rows] = await legacy.query<RowDataPacket[]>(
    'SELECT parent_id FROM member_network WHERE member_id = ? AND parent_id IS NOT NULL ORDER BY COALESCE(updated, created) DESC LIMIT 1',
    [memberId],
  );
  const parentNode = (rows as any[])[0]?.parent_id;
  if (parentNode == null) return null;
  const [parents] = await legacy.query<RowDataPacket[]>(
    'SELECT member_id FROM member_network WHERE member_network_id = ?',
    [Number(parentNode)],
  );
  const mid = (parents as any[])[0]?.member_id;
  return mid != null ? Number(mid) : null;
}

/** Walk the legacy `member_network` parent chain (redirect-resolved), bounded for display. */
async function legacyChain(legacy: LegacyClient, redirect: Map<number, number>, startLegacyId: number): Promise<string> {
  const parts: string[] = [];
  let member: number | null = startLegacyId;
  for (let hop = 0; hop < 6 && member !== null; hop += 1) {
    const resolved: number = redirect.get(member) ?? member;
    parts.push(resolved === member ? String(member) : `${member}→${resolved}`);
    member = await legacyParentMember(legacy, resolved);
  }
  return parts.join(' → ') || '(no legacy chain)';
}

async function main(): Promise<void> {
  const lock = await acquireLock(prisma);
  if (!lock) {
    console.error('another resync run holds the lock — try again later (or pnpm resync:unlock if stale)');
    process.exitCode = 1;
    return;
  }
  const legacy = await connectResilientLegacy({ dateStrings: false }, resyncConfig.legacyReconnectRetries, log);
  try {
    const redirect = new Map<number, number>();
    for (const r of await prisma.memberRedirect.findMany({
      select: { loserLegacyId: true, winnerLegacyId: true },
    })) {
      redirect.set(r.loserLegacyId, r.winnerLegacyId);
    }
    const memberByLegacy = new Map<number, string>();
    for (const m of await prisma.member.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } })) {
      if (m.legacyId !== null) memberByLegacy.set(m.legacyId, m.id);
    }
    const resolve = (id: number | null | undefined): string | undefined =>
      id == null ? undefined : memberByLegacy.get(redirect.get(id) ?? id);

    log(`mode=${APPLY ? 'APPLY' : 'dry-run'} corrections=${INVITER_CORRECTIONS.length}`);

    let changed = 0;
    let skipped = 0;
    for (const c of INVITER_CORRECTIONS) {
      log('─'.repeat(72));
      log(`legacy ${c.legacyId}: ${c.note}`);
      const subjectId = resolve(c.legacyId);
      if (!subjectId) {
        log(`  SKIP — subject legacy ${c.legacyId} is not migrated`);
        skipped += 1;
        continue;
      }
      const subject = await prisma.member.findUnique({
        where: { id: subjectId },
        select: { inviterId: true, inviterSource: true },
      });
      const proposedInviterId = c.newInviterLegacyId == null ? null : resolve(c.newInviterLegacyId) ?? null;
      if (c.newInviterLegacyId != null && !proposedInviterId) {
        log(`  SKIP — proposed inviter legacy ${c.newInviterLegacyId} is not migrated`);
        skipped += 1;
        continue;
      }
      try {
        log(`  legacy parent chain : ${await legacyChain(legacy, redirect, c.legacyId)}`);
      } catch {
        log('  legacy parent chain : (unavailable)');
      }
      log(`  current             : inviter=${subject?.inviterId ?? 'NULL'} source=${subject?.inviterSource ?? 'NULL'}`);
      log(`  proposed            : inviter=${proposedInviterId ?? 'NULL'} (legacy ${c.newInviterLegacyId ?? 'NULL'})`);

      const closes =
        proposedInviterId && proposedInviterId !== subject?.inviterId
          ? await wouldCloseCycle(subjectId, proposedInviterId)
          : false;
      const plan = planInviterCorrection({
        currentInviterId: subject?.inviterId ?? null,
        currentSource: subject?.inviterSource ?? null,
        subjectId,
        proposedInviterId,
        proposedClosesCycle: closes,
        allowAppOwned: !!c.allowAppOwned,
      });
      if (!plan.patch) {
        log(`  → ${plan.outcome} (no write)`);
        skipped += 1;
        continue;
      }
      if (!APPLY) {
        log(`  → would set inviterId=${plan.patch.inviterId ?? 'NULL'} source=${plan.patch.inviterSource ?? 'NULL'} [dry-run]`);
        changed += 1;
        continue;
      }
      const res = await prisma.member.updateMany({
        // optimistic gate: only write if the row still holds the values we read
        where: { id: subjectId, inviterId: subject?.inviterId ?? null, inviterSource: subject?.inviterSource ?? null },
        data: plan.patch,
      });
      if (res.count === 1) {
        log(`  → set inviterId=${plan.patch.inviterId ?? 'NULL'} source=${plan.patch.inviterSource ?? 'NULL'}`);
        changed += 1;
      } else {
        log('  → not applied: the row changed meanwhile (re-run)');
        skipped += 1;
      }
    }

    log('─'.repeat(72));
    log(`${APPLY ? 'applied' : 'would change'}=${changed} skipped=${skipped}`);
    if (APPLY) {
      log('next: pnpm resync tree --dry-run --since=1970-01-01T00:00:00Z   (then without --dry-run)');
    } else {
      log('dry-run — re-run with --apply to write');
    }
  } finally {
    await releaseLock(prisma, lock);
    await legacy.end();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
