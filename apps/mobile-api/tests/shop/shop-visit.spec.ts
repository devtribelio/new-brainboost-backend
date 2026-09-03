/**
 * Shop tracking-link visits (ShopVisitService).
 *
 * Two invariants carry the whole feature:
 *   - the write NEVER throws and NEVER rejects a click (a marketing link that
 *     errors loses the visit it exists to measure)
 *   - clientEventId dedupes RETRIES, not visits — a refresh must produce a new
 *     row, else "Kunjungan" collapses onto "Pengunjung unik"
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { ShopVisitService } from '@bb/domain/shop/visit.service';

const TAG = `shop-visit-${Date.now()}`;
const svc = new ShopVisitService();

describe('ShopVisitService', () => {
  const guestIds: string[] = [];
  const memberIds: string[] = [];
  let productId = '';
  let productCode = '';

  function newGuest(): string {
    const g = `${TAG}-${randomUUID()}`;
    guestIds.push(g);
    return g;
  }

  beforeAll(async () => {
    const p = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: 100_000, code: `${TAG}-code` },
    });
    productId = p.id;
    productCode = p.code!;
  });

  afterAll(async () => {
    if (guestIds.length) await prisma.shopVisit.deleteMany({ where: { guestId: { in: guestIds } } });
    if (memberIds.length) await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    if (productId) await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('logs a visit with the full UTM set and resolves productCode', async () => {
    const guestId = newGuest();
    const res = await svc.logVisit({
      guestId,
      productCode,
      utmSource: 'webinar',
      utmMedium: 'email',
      utmCampaign: 'sep26',
      utmContent: 'banner-a',
      utmTerm: 'kelas-online',
      referer: 'https://t.co/abc',
    });
    expect(res.status).toBe('logged');

    const row = await prisma.shopVisit.findFirstOrThrow({ where: { guestId } });
    expect(row.productId).toBe(productId);
    expect(row.utmSource).toBe('webinar');
    expect(row.utmCampaign).toBe('sep26');
    expect(row.memberId).toBeNull();
  });

  it('an unknown productCode degrades to a product-less visit, never a rejection', async () => {
    const guestId = newGuest();
    const res = await svc.logVisit({ guestId, productCode: 'no-such-product-anywhere' });
    expect(res.status).toBe('logged');
    const row = await prisma.shopVisit.findFirstOrThrow({ where: { guestId } });
    expect(row.productId).toBeNull();
  });

  it('reports invalid (never throws) when guestId is missing', async () => {
    const res = await svc.logVisit({ utmSource: 'webinar' });
    expect(res.status).toBe('invalid');
  });

  it('drops unfurl/crawler user agents so they cannot inflate unique visitors', async () => {
    const guestId = newGuest();
    const res = await svc.logVisit({ guestId, userAgent: 'WhatsApp/2.23 A' });
    expect(res.status).toBe('invalid');
    expect(await prisma.shopVisit.count({ where: { guestId } })).toBe(0);
  });

  it('dedupes a RETRY of the same clientEventId', async () => {
    const guestId = newGuest();
    const clientEventId = randomUUID();
    const first = await svc.logVisit({ guestId, clientEventId });
    const retry = await svc.logVisit({ guestId, clientEventId });
    expect(first.status).toBe('logged');
    expect(retry.status).toBe('duplicate');
    expect(await prisma.shopVisit.count({ where: { guestId } })).toBe(1);
  });

  it('counts a repeat visit as a new row — dedupe is per send, not per guest', async () => {
    const guestId = newGuest();
    await svc.logVisit({ guestId, clientEventId: randomUUID() });
    await svc.logVisit({ guestId, clientEventId: randomUUID() });
    expect(await prisma.shopVisit.count({ where: { guestId } })).toBe(2);
  });

  describe('claimForMember', () => {
    async function mkMember(): Promise<string> {
      const m = await prisma.member.create({
        data: { email: `${TAG}-${randomUUID()}@t.local`, passwordHash: await bcrypt.hash('x', 4) },
      });
      memberIds.push(m.id);
      return m.id;
    }

    it('binds every unclaimed visit of that guest and is idempotent', async () => {
      const guestId = newGuest();
      const memberId = await mkMember();
      await svc.logVisit({ guestId, utmSource: 'webinar' });
      await svc.logVisit({ guestId, utmSource: 'webinar' });

      const first = await svc.claimForMember(memberId, guestId);
      expect(first.claimed).toBe(2);

      const again = await svc.claimForMember(memberId, guestId);
      expect(again.claimed).toBe(0);

      const rows = await prisma.shopVisit.findMany({ where: { guestId } });
      expect(rows.every((r) => r.memberId === memberId)).toBe(true);
    });

    it('never re-binds a visit that already belongs to another member', async () => {
      const guestId = newGuest();
      const first = await mkMember();
      const second = await mkMember();
      await svc.logVisit({ guestId });
      await svc.claimForMember(first, guestId);

      const res = await svc.claimForMember(second, guestId);
      expect(res.claimed).toBe(0);
      const row = await prisma.shopVisit.findFirstOrThrow({ where: { guestId } });
      expect(row.memberId).toBe(first);
    });

    it('ignores visits older than the 30-day claim window', async () => {
      const guestId = newGuest();
      const memberId = await mkMember();
      await prisma.shopVisit.create({
        data: { guestId, createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) },
      });
      const res = await svc.claimForMember(memberId, guestId);
      expect(res.claimed).toBe(0);
    });

    it('a blank guestId claims nothing', async () => {
      const memberId = await mkMember();
      expect((await svc.claimForMember(memberId, '   ')).claimed).toBe(0);
    });
  });
});
