/**
 * Writes a legacy `member.affiliator_code` onto a migrated member without ever breaking a
 * link already in circulation (members + tree syncers share this).
 *
 * - member has no code yet            → set it
 * - member already has another code   → keep it, alias the legacy code to the member, so
 *                                       links under BOTH codes resolve (the app-allocated
 *                                       one may already be shared; legacy keeps issuing the
 *                                       legacy one during cutover)
 * - code held by another member/alias → leave it, report a collision
 *
 * Both tables are checked because `resolveAffiliateCode` reads members first, then aliases:
 * one code in both places would silently take attribution away from the alias owner.
 */
import type { PrismaClient } from '@prisma/client';

export const ALIAS_SOURCE_LEGACY_CODE = 'LEGACY_CODE';

export type CodeAction = 'none' | 'same' | 'set' | 'alias' | 'collision';

export interface CodeState {
  legacyCode: string | null;
  memberId: string;
  memberCode: string | null;
  /** member whose `affiliate_code` equals legacyCode, if any */
  holderId: string | null;
  /** member an alias for legacyCode points at, if any */
  aliasOwnerId: string | null;
}

export function decideLegacyCode(s: CodeState): CodeAction {
  if (!s.legacyCode) return 'none';
  if (s.holderId) return s.holderId === s.memberId ? 'same' : 'collision';
  if (s.aliasOwnerId) return s.aliasOwnerId === s.memberId ? 'same' : 'collision';
  return s.memberCode ? 'alias' : 'set';
}

export async function syncLegacyAffiliateCode(
  prisma: PrismaClient,
  memberId: string,
  legacyCode: string | null,
): Promise<CodeAction> {
  if (!legacyCode) return 'none';
  const [member, holder, alias] = await Promise.all([
    prisma.member.findUnique({ where: { id: memberId }, select: { affiliateCode: true } }),
    prisma.member.findUnique({ where: { affiliateCode: legacyCode }, select: { id: true } }),
    prisma.memberAffiliateCodeAlias.findUnique({ where: { code: legacyCode }, select: { memberId: true } }),
  ]);
  if (!member) return 'none';
  const action = decideLegacyCode({
    legacyCode,
    memberId,
    memberCode: member.affiliateCode,
    holderId: holder?.id ?? null,
    aliasOwnerId: alias?.memberId ?? null,
  });
  try {
    if (action === 'set') {
      // conditional: an app allocation racing us keeps its code; ours becomes an alias next run
      const res = await prisma.member.updateMany({
        where: { id: memberId, affiliateCode: null },
        data: { affiliateCode: legacyCode },
      });
      return res.count ? 'set' : 'none';
    }
    if (action === 'alias') {
      await prisma.memberAffiliateCodeAlias.createMany({
        data: [{ code: legacyCode, memberId, source: ALIAS_SOURCE_LEGACY_CODE }],
        skipDuplicates: true,
      });
    }
  } catch (err: any) {
    if (err?.code === 'P2002') return 'collision';
    throw err;
  }
  return action;
}
