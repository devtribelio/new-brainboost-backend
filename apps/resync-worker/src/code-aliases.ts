/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Affiliate codes of legacy dedup losers → `member_affiliate_code_aliases`.
 *
 * Legacy dedup merged several accounts of one person into a winner (`member_redirect`).
 * Only the winner's `member.affiliator_code` landed in `members.affiliate_code`, so a
 * link or connect under a LOSER's code resolved to nobody. For every redirect row this
 * re-points the loser's legacy code at the winner's PG member; the app reads it through
 * `resolveAffiliateCode` (members first, then alias).
 *
 * Only for merges of the SAME person (PRD P0-5 fix 3): loser and winner must share an email
 * or a Google/Apple sub on legacy. Most redirects were made on a shared phone alone, and ~87
 * of those are likely different people — aliasing them would route one person's affiliate
 * links (and commissions) to someone else. Those wait for the P0-5 split review.
 *
 * Never overwrites: a code already held by a member or aliased elsewhere is logged as a
 * collision and left alone. Idempotent (an existing alias to the same winner is a skip).
 * A wrong merge is undone by `resync:identity split`, which deletes the loser's alias.
 *
 *   pnpm resync:code-aliases [--dry-run]
 */
import { emptyStats, type RunCtx, type Stats } from './types';
import { nonEmpty } from './util';

export const ALIAS_SOURCE_LEGACY_DEDUP = 'LEGACY_DEDUP';
const CHUNK = 1000;

export interface AliasInput {
  /** loser's legacy `member.affiliator_code` */
  code: string | null;
  /** PG member the loser was merged into */
  winnerMemberId: string | undefined;
  /** PG member whose own `affiliate_code` is this code, if any */
  codeMemberId: string | null;
  /** PG member an existing alias for this code points at, if any */
  aliasMemberId: string | null;
  /** loser and winner share an email or Google/Apple sub on legacy */
  samePerson: boolean;
}

export type AliasDecision =
  | { action: 'create' }
  | { action: 'skip'; reason: 'no_code' | 'no_winner' | 'not_same_person' | 'winner_own_code' | 'already_aliased' }
  | { action: 'collision'; reason: 'held_by_member' | 'aliased_to_other' };

export function decideCodeAlias(i: AliasInput): AliasDecision {
  if (!i.code) return { action: 'skip', reason: 'no_code' };
  if (!i.winnerMemberId) return { action: 'skip', reason: 'no_winner' };
  if (!i.samePerson) return { action: 'skip', reason: 'not_same_person' };
  if (i.codeMemberId === i.winnerMemberId) return { action: 'skip', reason: 'winner_own_code' };
  if (i.codeMemberId) return { action: 'collision', reason: 'held_by_member' };
  if (i.aliasMemberId === i.winnerMemberId) return { action: 'skip', reason: 'already_aliased' };
  if (i.aliasMemberId) return { action: 'collision', reason: 'aliased_to_other' };
  return { action: 'create' };
}

function chunk<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function syncCodeAliases(
  ctx: Pick<RunCtx, 'prisma' | 'legacy' | 'dryRun' | 'log'>,
): Promise<Stats> {
  const stats = emptyStats();
  const redirects = await ctx.prisma.memberRedirect.findMany({
    select: { loserLegacyId: true, winnerLegacyId: true },
  });
  if (!redirects.length) return stats;

  // loser legacyId -> legacy affiliator_code; every loser + winner -> strong identity keys
  const loserCode = new Map<number, string>();
  const keysOf = new Map<number, string[]>();
  const allIds = [...new Set(redirects.flatMap((r) => [r.loserLegacyId, r.winnerLegacyId]))];
  for (const ids of chunk(allIds)) {
    const [rows] = await ctx.legacy.query(
      'SELECT member_id, affiliator_code, email, google_id, sign_in_with_apple_id FROM member WHERE member_id IN (?)',
      [ids],
    );
    for (const r of rows as any[]) {
      const id = Number(r.member_id);
      const code = nonEmpty(r.affiliator_code);
      if (code) loserCode.set(id, code);
      const email = nonEmpty(r.email)?.toLowerCase();
      keysOf.set(
        id,
        [email && `e:${email}`, nonEmpty(r.google_id) && `g:${r.google_id}`, nonEmpty(r.sign_in_with_apple_id) && `a:${r.sign_in_with_apple_id}`].filter(
          Boolean,
        ) as string[],
      );
    }
  }
  const samePerson = (loser: number, winner: number) => {
    const w = new Set(keysOf.get(winner) ?? []);
    return (keysOf.get(loser) ?? []).some((k) => w.has(k));
  };

  const winnerByLegacy = new Map<number, string>();
  for (const ids of chunk([...new Set(redirects.map((r) => r.winnerLegacyId))])) {
    for (const m of await ctx.prisma.member.findMany({
      where: { legacyId: { in: ids } },
      select: { id: true, legacyId: true },
    })) {
      winnerByLegacy.set(m.legacyId!, m.id);
    }
  }

  const codes = [...new Set(loserCode.values())];
  const codeMember = new Map<string, string>();
  const aliasMember = new Map<string, string>();
  for (const cs of chunk(codes)) {
    for (const m of await ctx.prisma.member.findMany({
      where: { affiliateCode: { in: cs } },
      select: { id: true, affiliateCode: true },
    })) {
      codeMember.set(m.affiliateCode!, m.id);
    }
    for (const a of await ctx.prisma.memberAffiliateCodeAlias.findMany({
      where: { code: { in: cs } },
      select: { code: true, memberId: true },
    })) {
      aliasMember.set(a.code, a.memberId);
    }
  }

  const toCreate: { code: string; memberId: string; source: string }[] = [];
  for (const r of redirects) {
    stats.scanned += 1;
    const code = loserCode.get(r.loserLegacyId) ?? null;
    const winnerMemberId = winnerByLegacy.get(r.winnerLegacyId);
    const d = decideCodeAlias({
      code,
      winnerMemberId,
      codeMemberId: code ? codeMember.get(code) ?? null : null,
      // includes aliases planned earlier in this run, so two losers sharing a code collide
      aliasMemberId: code ? aliasMember.get(code) ?? null : null,
      samePerson: samePerson(r.loserLegacyId, r.winnerLegacyId),
    });
    if (d.action === 'create') {
      toCreate.push({ code: code!, memberId: winnerMemberId!, source: ALIAS_SOURCE_LEGACY_DEDUP });
      aliasMember.set(code!, winnerMemberId!);
      continue;
    }
    stats.skipped += 1;
    if (d.action === 'collision') {
      ctx.log(
        `WARN: code ${code} of loser legacyId=${r.loserLegacyId} (winner ${r.winnerLegacyId}) not aliased — ${d.reason}`,
      );
    }
  }

  if (!ctx.dryRun) {
    for (const data of chunk(toCreate)) {
      const res = await ctx.prisma.memberAffiliateCodeAlias.createMany({ data, skipDuplicates: true });
      stats.upserted += res.count;
    }
  } else {
    stats.upserted = toCreate.length;
  }
  ctx.log(
    `code-aliases: redirects=${stats.scanned} ${ctx.dryRun ? 'would create' : 'created'}=${stats.upserted} skipped=${stats.skipped}`,
  );
  return stats;
}
