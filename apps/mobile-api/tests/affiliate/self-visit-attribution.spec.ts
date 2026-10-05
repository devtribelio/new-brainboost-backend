/**
 * A buyer's click on their OWN affiliate code carries no attribution value — nobody
 * may earn on their own purchase. It must neither mask an earlier affiliator's
 * click (resolver) nor be stored (visit logger) nor overwrite the web `bb_aff`
 * cookie that checkout reads as the explicit code.
 *
 * Incident: BB-20261004-0088 — affiliator click 23:38, own-code click 23:39:41,
 * order 23:39:53 → no commission. PRD: prd-affiliate-self-visit-attribution.md.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { prisma } from '@bb/db';
import { AttributionService } from '@bb/domain/affiliate/attribution.service';
import { VisitService } from '@bb/domain/affiliate/visit.service';
import { AFFILIATE_COOKIE_NAME } from '@bb/domain/affiliate/constants';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { AffiliateController } from '../../src/modules/affiliate/affiliate.controller';

const TAG = `self-visit-${Date.now()}`;
const attribution = new AttributionService();
const visits = new VisitService();

function code(): string {
  return randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
}

describe('affiliate self-visit', () => {
  const memberIds: string[] = [];
  let productId = '';

  async function mkMember(): Promise<{ id: string; affiliateCode: string }> {
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-${randomUUID()}@t.local`,
        passwordHash: await bcrypt.hash('x', 4),
        affiliateCode: code(),
      },
      select: { id: true, affiliateCode: true },
    });
    memberIds.push(m.id);
    return { id: m.id, affiliateCode: m.affiliateCode! };
  }

  async function visit(affiliatorMemberId: string, memberId: string, minutesAgo: number) {
    await prisma.affiliateVisit.create({
      data: {
        affiliatorMemberId,
        memberId,
        productId,
        createdAt: new Date(Date.now() - minutesAgo * 60 * 1000),
      },
    });
  }

  beforeAll(async () => {
    const p = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: 298_000 },
    });
    productId = p.id;
  });

  afterAll(async () => {
    if (memberIds.length) {
      await prisma.affiliateVisit.deleteMany({
        where: {
          OR: [{ memberId: { in: memberIds } }, { affiliatorMemberId: { in: memberIds } }],
        },
      });
      await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    }
    if (productId) await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.$disconnect();
  });

  describe('AttributionService.resolveOverrideAffiliatorMemberId', () => {
    it('skips a newer own-code click and attributes the earlier affiliator click', async () => {
      const buyer = await mkMember();
      const aff = await mkMember();
      await visit(aff.id, buyer.id, 10);
      await visit(buyer.id, buyer.id, 1);

      const r = await attribution.resolveOverrideAffiliatorMemberId(buyer.id, null, productId);
      expect(r).toBe(aff.id);
    });

    it('returns null when the only clicks are own-code clicks (engine falls back to inviter)', async () => {
      const buyer = await mkMember();
      await visit(buyer.id, buyer.id, 1);

      const r = await attribution.resolveOverrideAffiliatorMemberId(buyer.id, null, productId);
      expect(r).toBeNull();
    });

    it('an explicit own code falls through to the affiliator click', async () => {
      const buyer = await mkMember();
      const aff = await mkMember();
      await visit(aff.id, buyer.id, 5);

      const r = await attribution.resolveOverrideAffiliatorMemberId(
        buyer.id,
        buyer.affiliateCode,
        productId,
      );
      expect(r).toBe(aff.id);
    });
  });

  describe('VisitService.logVisit', () => {
    it('does not store a click on the visitor’s own code', async () => {
      const buyer = await mkMember();

      const res = await visits.logVisit({ affiliatorCode: buyer.affiliateCode, memberId: buyer.id });

      expect(res).toEqual({ status: 'skipped', reason: 'self' });
      expect(await prisma.affiliateVisit.count({ where: { memberId: buyer.id } })).toBe(0);
    });

    it('still stores an anonymous click and a click on someone else’s code', async () => {
      const buyer = await mkMember();
      const aff = await mkMember();

      const anon = await visits.logVisit({ affiliatorCode: buyer.affiliateCode });
      const other = await visits.logVisit({ affiliatorCode: aff.affiliateCode, memberId: buyer.id });

      expect(anon.status).toBe('logged');
      expect(other.status).toBe('logged');
    });
  });

  describe('AffiliateController.logVisit cookie', () => {
    const ctrl = new AffiliateController(
      null as never,
      null as never,
      null as never,
      visits,
      null as never,
    );

    async function post(affiliatorCode: string, userId: string) {
      const cookies: string[] = [];
      const res = {
        cookie: (name: string) => {
          cookies.push(name);
          return res;
        },
        status: () => res,
        json: () => res,
      } as unknown as Response;
      const req = {
        body: { affiliatorCode },
        query: {},
        headers: {},
        url: '/api/member/affiliate/visits',
        user: { id: userId },
        socket: {},
      } as unknown as AuthenticatedRequest;
      await ctrl.logVisit(req, res);
      return cookies;
    }

    it('does not overwrite the attribution cookie with the visitor’s own code', async () => {
      const buyer = await mkMember();
      expect(await post(buyer.affiliateCode, buyer.id)).not.toContain(AFFILIATE_COOKIE_NAME);
    });

    it('sets the attribution cookie for someone else’s code', async () => {
      const buyer = await mkMember();
      const aff = await mkMember();
      expect(await post(aff.affiliateCode, buyer.id)).toContain(AFFILIATE_COOKIE_NAME);
    });
  });
});
