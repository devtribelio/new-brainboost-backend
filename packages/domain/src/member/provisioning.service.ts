import { randomUUID } from 'node:crypto';
import type { Member, Prisma } from '@prisma/client';
import { prisma } from '@bb/db';

/**
 * Shared "create a brand-new Member" primitives, extracted so the social-login
 * path (AuthService) and the 3rd-party ingest provisioning path
 * (PurchaseIngestService) build members from ONE implementation instead of two
 * copies that could drift on the sentinel password, the unique code/username
 * generation, or the community auto-join.
 *
 * Deliberately NOT a full "sign the buyer up" flow: race recovery differs per
 * caller (social login re-resolves by provider sub then email and links;
 * ingest re-resolves by email), so `provisionMember` lets the P2002 propagate
 * and each caller owns its recovery. See `isUniqueViolation`.
 */

/** Columns `provisionMember` fills itself — callers supply everything else. */
type ProvisionedFields = 'passwordHash' | 'passwordAlgo' | 'code' | 'affiliateCode' | 'username';

export interface ProvisionMemberInput {
  /**
   * All caller-controlled columns: email, fullName, phone, phoneCode,
   * googleSub/appleSub, inviterId, isActive, isEmailVerified, … Whatever is not
   * passed keeps its schema default.
   */
  data: Omit<Prisma.MemberUncheckedCreateInput, ProvisionedFields>;
  /**
   * Seed for the generated username when `data.email` is absent (e.g. Apple
   * private-relay signup: `${provider}${sub}`).
   */
  usernameSeed?: string | null;
}

export class MemberProvisioningService {
  /**
   * Sentinel password for accounts created without a chosen password (social
   * login, channel provisioning). Two random UUIDs is not a valid hash for any
   * algorithm, so `loginWithPassword` (gated on `passwordAlgo`) can never
   * authenticate it — the account is claimed later via its real flow.
   */
  sentinelPasswordHash(): string {
    return `${randomUUID()}${randomUUID()}`;
  }

  isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'P2002'
    );
  }

  async generateUniqueMemberCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      const exists = await prisma.member.findFirst({
        where: { OR: [{ code }, { affiliateCode: code }] },
        select: { id: true },
      });
      if (!exists) return code;
    }
    throw new Error('Unable to generate unique member code after 5 attempts');
  }

  async deriveUniqueUsernameFromEmail(email: string): Promise<string> {
    const local = email.split('@')[0] ?? 'user';
    const base =
      local
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, '')
        .slice(0, 24) || 'user';
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = attempt === 0 ? base : `${base}${randomUUID().slice(0, 6)}`;
      const exists = await prisma.member.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    // Extremely unlikely; fall back to random.
    return `${base}${randomUUID().slice(0, 8)}`;
  }

  // Auto-join the default community networks (Timeline + Education) on every
  // new member. Mirrors what mobile MainPage previously triggered via
  // /api/member/info → /api/network/join, but guarantees the rows exist before
  // the first feed render. Idempotent: per-network unique violation is swallowed
  // so a retried registration cannot double-join or double-bump countMember.
  async autoJoinCommunityNetworks(memberId: string): Promise<void> {
    const communities = await prisma.network.findMany({
      where: { purpose: { in: ['timeline', 'education'] }, isActive: true },
      select: { id: true },
    });
    for (const n of communities) {
      try {
        await prisma.$transaction([
          prisma.networkMember.create({ data: { networkId: n.id, memberId } }),
          prisma.network.update({
            where: { id: n.id },
            data: { countMember: { increment: 1 } },
          }),
        ]);
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
      }
    }
  }

  /**
   * Create a brand-new Member with the shared defaults (sentinel social
   * password, unique `code`/`affiliateCode`, unique `username`) and auto-join
   * the community networks.
   *
   * Does NOT swallow a unique-constraint violation: the caller owns race
   * recovery (which differs by channel), so callers MUST catch
   * `isUniqueViolation(err)` and re-resolve the winning row.
   */
  async provisionMember(input: ProvisionMemberInput): Promise<Member> {
    const code = await this.generateUniqueMemberCode();
    const usernameSource = input.data.email ?? input.usernameSeed ?? `user${code}`;
    const username = await this.deriveUniqueUsernameFromEmail(usernameSource);

    const created = await prisma.member.create({
      data: {
        ...input.data,
        passwordHash: this.sentinelPasswordHash(),
        passwordAlgo: 'social',
        code,
        affiliateCode: code,
        username,
      },
    });
    await this.autoJoinCommunityNetworks(created.id);
    return created;
  }
}

export const memberProvisioningService = new MemberProvisioningService();
