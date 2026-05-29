/**
 * Affiliate commission — LEGACY PARITY (golden test).
 *
 * Feeds real legacy production payouts (tests/affiliate/fixtures/legacy-commission-parity.json,
 * extracted from tribelio_db) through the actual engine `AffiliatorService.commitCommissionsForPayment`
 * and asserts the produced AffiliateCommission rows match legacy exactly (recipient position, level,
 * rate, amount). This is the safety net for the affiliate rewrite: any change to the commission
 * engine must keep these green.
 *
 * Each scenario seeds a throwaway inviter subtree in the test Postgres:
 *   buyer.inviterId -> level1 -> level2 -> ... -> levelN   (level1 = buyer's direct affiliator)
 * PERFORMANCE tiers seed a prior BALANCE commission so getLifetimeAmount() lands in the right tier.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL). Regenerate fixtures with:
 *   pnpm tsx scripts/extract-affiliate-parity-fixtures.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { AffiliatorService } from '@bb/domain/affiliate/affiliator.service';

interface ChainNode {
  level: number;
  affiliateBased: string;
  seedLifetime?: number;
}
interface ExpectedRow {
  level: number;
  rate: number;
  amount: number;
}
interface Scenario {
  name: string;
  legacyRef: string;
  productPrice: number;
  voucherAmount: number;
  chain: ChainNode[];
  expected: ExpectedRow[];
}

const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/legacy-commission-parity.json'), 'utf8'),
) as { scenarios: Scenario[] };

const svc = new AffiliatorService();
const TAG = `parity-${Date.now()}`;

describe('affiliate commission — legacy parity (golden fixtures)', () => {
  const createdMemberIds: string[] = [];
  let programId = '';
  let productId = '';

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: 0 },
    });
    productId = product.id;
    const program = await prisma.affiliateProgram.create({
      data: { code: `${TAG}-prog`, name: 'Parity Program', productId, isActive: true },
    });
    programId = program.id;
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { programId } });
    await prisma.memberAffiliator.deleteMany({ where: { programId } });
    await prisma.affiliateProgram.delete({ where: { id: programId } });
    await prisma.product.delete({ where: { id: productId } });
    if (createdMemberIds.length) {
      await prisma.member.deleteMany({ where: { id: { in: createdMemberIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeMember(affiliateBased: string, inviterId: string | null): Promise<string> {
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@parity.local`,
        passwordHash: await bcrypt.hash('x', 4),
        affiliateBased,
        inviterId,
      },
    });
    createdMemberIds.push(m.id);
    return m.id;
  }

  for (const sc of fixtures.scenarios) {
    it(sc.name, async () => {
      // Build upline subtree from the topmost seeded level down to level 1.
      // levelI.inviterId = level(I+1).id ; the topmost has no further inviter.
      const topDown = [...sc.chain].sort((a, b) => b.level - a.level);
      const levelToMemberId = new Map<number, string>();
      let childInviterId: string | null = null;
      for (const node of topDown) {
        const id = await makeMember(node.affiliateBased, childInviterId);
        levelToMemberId.set(node.level, id);
        childInviterId = id;

        // Reconstruct PERFORMANCE cumulative tier via a prior BALANCE commission.
        if (node.seedLifetime && node.seedLifetime > 0) {
          await prisma.affiliateCommission.create({
            data: {
              recipientId: id,
              programId,
              productId,
              paymentId: randomUUID(),
              level: 1,
              affiliateBased: 'PERFORMANCE',
              schemaType: null,
              productPrice: node.seedLifetime,
              voucherAmount: 0,
              commissionRate: 100,
              amount: node.seedLifetime,
              status: 'BALANCE',
            },
          });
        }
      }

      const level1Id = levelToMemberId.get(1)!;
      const buyerId = await makeMember('PERFORMANCE', level1Id);

      const paymentId = randomUUID();
      const res = await svc.commitCommissionsForPayment({
        paymentId,
        productId,
        productPrice: sc.productPrice,
        voucherAmount: sc.voucherAmount,
        buyerMemberId: buyerId,
        programId,
      });

      const rows = await prisma.affiliateCommission.findMany({
        where: { paymentId },
        orderBy: { level: 'asc' },
      });

      // Same number of recipients paid as legacy.
      expect(res.committed).toBe(sc.expected.length);
      expect(rows.length).toBe(sc.expected.length);

      for (const exp of sc.expected) {
        const row = rows.find((r) => r.level === exp.level);
        expect(row, `expected a commission row at level ${exp.level}`).toBeTruthy();
        expect(row!.recipientId).toBe(levelToMemberId.get(exp.level));
        expect(row!.commissionRate, `rate @ level ${exp.level}`).toBe(exp.rate);
        expect(row!.amount, `amount @ level ${exp.level}`).toBe(exp.amount);
      }
    });
  }
});
