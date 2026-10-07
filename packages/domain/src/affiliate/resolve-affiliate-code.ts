import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@bb/db';

type CodeDb = Pick<PrismaClient, 'member' | 'memberAffiliateCodeAlias'>;

/**
 * The ONE lookup from an affiliate code to the member who owns it. Every
 * code-to-member read (affiliate connect, register/pre-register/social inviter,
 * visit logging, checkout explicit code / `bb_aff` cookie) goes through here.
 *
 * Precedence: `members.affiliate_code` first, then `member_affiliate_code_aliases`
 * (a legacy dedup loser's code, re-pointed at the winner). The allocators keep the
 * two sets disjoint, so the order only matters if that invariant is ever broken —
 * and then the member's own code must win over an alias.
 *
 * The code is matched as given: callers that receive the `<code><networkLegacyId>`
 * wire format slice it first, as before.
 */
export async function resolveAffiliateCode<S extends Prisma.MemberSelect>(
  code: string | null | undefined,
  select: S,
  db: CodeDb = prisma,
): Promise<Prisma.MemberGetPayload<{ select: S }> | null> {
  if (!code) return null;
  const direct = await db.member.findUnique({ where: { affiliateCode: code }, select });
  if (direct) return direct as Prisma.MemberGetPayload<{ select: S }>;

  const alias = await db.memberAffiliateCodeAlias.findUnique({
    where: { code },
    select: { memberId: true },
  });
  if (!alias) return null;
  const owner = await db.member.findUnique({ where: { id: alias.memberId }, select });
  return owner as Prisma.MemberGetPayload<{ select: S }> | null;
}

/** True when `code` is free: neither a member's own code nor an alias. Used by the allocators. */
export async function isAffiliateCodeFree(code: string, db: CodeDb = prisma): Promise<boolean> {
  const [member, alias] = await Promise.all([
    db.member.findUnique({ where: { affiliateCode: code }, select: { id: true } }),
    db.memberAffiliateCodeAlias.findUnique({ where: { code }, select: { code: true } }),
  ]);
  return !member && !alias;
}
