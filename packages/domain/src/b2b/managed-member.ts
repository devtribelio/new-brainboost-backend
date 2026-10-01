import { prisma } from '@bb/db';

/**
 * "B2B-managed" member: an account the B2B backend created for an employee
 * (`members.signup_source = 'b2b'`) that STILL holds at least one active company
 * seat (an active `b2b_member_grant` on an active plan).
 *
 * Such members are excluded from consumer marketing — first-purchase voucher,
 * topic digest, community push, promo banners — because they reach Brainboost
 * through their employer, not as retail customers (PRD b2b-db-consolidation,
 * "Akun yang dibuat B2B dikecualikan dari marketing"). The exclusion ends by itself
 * when the last seat goes: `signup_source` is a birth fact that never changes, the
 * "still B2B" half is always derived from the grants, never stored.
 *
 * A regular Brainboost account later enrolled by a company (`signup_source` null)
 * is NOT excluded — that person is a retail customer too.
 */
const ACTIVE_SEAT = { isActive: true, paymentPlan: { isActive: true } } as const;

export async function isB2bManagedMember(memberId: string): Promise<boolean> {
  const hit = await prisma.member.findFirst({
    where: { id: memberId, signupSource: 'b2b', b2bGrants: { some: ACTIVE_SEAT } },
    select: { id: true },
  });
  return hit !== null;
}

/** The subset of `memberIds` that are B2B-managed. One query for the whole batch. */
export async function b2bManagedMemberIds(memberIds: string[]): Promise<Set<string>> {
  if (memberIds.length === 0) return new Set();
  const rows = await prisma.member.findMany({
    where: { id: { in: memberIds }, signupSource: 'b2b', b2bGrants: { some: ACTIVE_SEAT } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** `memberIds` without the B2B-managed ones, order preserved. */
export async function filterOutB2bManaged(memberIds: string[]): Promise<string[]> {
  const managed = await b2bManagedMemberIds(memberIds);
  return managed.size === 0 ? memberIds : memberIds.filter((id) => !managed.has(id));
}
