/**
 * Shortlink redirect (`GET /s/:slug`).
 *
 * Three things carry the feature and are asserted here:
 *   - a click NEVER dead-ends: unknown slug, inactive link, unusable product all
 *     land on the shop home instead of an error page
 *   - the redirect is 302, not 301 — a permanent redirect is cached by the
 *     browser forever, so a link whose voucher is later fixed can never be
 *     corrected for anyone who already clicked it
 *   - clicks are counted per (link, WIB day), and unfurl bots are not counted
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '@/app';
import { prisma } from '@bb/db';
import { SettingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { trackingLinkService } from '@bb/domain/shop/tracking-link.service';

const TAG = `shortlink-${Date.now()}`;

/** Poll until `probe` returns non-null, or fail after `timeoutMs`. */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the click to be recorded');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const SHOP = 'https://shop.test.local';

describe('GET /s/:slug', () => {
  const app = buildApp();
  const linkIds: string[] = [];
  let productId = '';
  let activeSlug = '';
  let inactiveSlug = '';
  let noRefSlug = '';

  async function mkLink(opts: {
    slug: string;
    productId?: string | null;
    promoId?: string | null;
    isActive?: boolean;
    voucherCode?: string | null;
    utmMedium?: string | null;
  }): Promise<string> {
    const link = await prisma.trackingLink.create({
      data: {
        name: `${TAG}-${opts.slug}`,
        slug: opts.slug,
        productId: opts.productId ?? null,
        promoId: opts.promoId ?? null,
        utmSource: 'webinar',
        utmMedium: opts.utmMedium ?? null,
        utmCampaign: opts.slug,
        voucherCode: opts.voucherCode ?? null,
        isActive: opts.isActive ?? true,
      },
      select: { id: true },
    });
    linkIds.push(link.id);
    return link.id;
  }

  beforeAll(async () => {
    await prisma.appSetting.upsert({
      where: { key: SETTING_KEYS.shopBaseUrl },
      create: { key: SETTING_KEYS.shopBaseUrl, value: SHOP },
      update: { value: SHOP },
    });
    SettingsService.clearCache();

    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-product`, price: 300_000, code: `${TAG}-code` },
    });
    productId = product.id;

    activeSlug = `${TAG}-aktif`;
    inactiveSlug = `${TAG}-nonaktif`;
    noRefSlug = `${TAG}-tanpa-ref`;

    await mkLink({ slug: activeSlug, productId, voucherCode: 'WEBINAR20', utmMedium: 'email' });
    await mkLink({ slug: inactiveSlug, productId, isActive: false });
    // A product with no code, slug or legacyId has no usable public reference.
    const bare = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-bare`, price: 1000 },
    });
    await mkLink({ slug: noRefSlug, productId: bare.id });
  });

  afterAll(async () => {
    if (linkIds.length) await prisma.trackingLink.deleteMany({ where: { id: { in: linkIds } } });
    await prisma.promo.deleteMany({ where: { slug: { startsWith: TAG } } });
    await prisma.voucher.deleteMany({ where: { code: { startsWith: TAG.toUpperCase() } } });
    await prisma.product.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.shopBaseUrl } });
    SettingsService.clearCache();
    await prisma.$disconnect();
  });

  it('redirects to the shop product URL with the full UTM set', async () => {
    const res = await request(app).get(`/s/${activeSlug}`);
    expect(res.status).toBe(302);

    const target = new URL(res.headers.location);
    expect(target.origin).toBe(SHOP);
    expect(target.pathname).toBe(`/product/${encodeURIComponent(`${TAG}-code`)}`);
    expect(target.searchParams.get('utm_source')).toBe('webinar');
    expect(target.searchParams.get('utm_medium')).toBe('email');
    expect(target.searchParams.get('utm_campaign')).toBe(activeSlug);
    expect(target.searchParams.get('voucher')).toBe('WEBINAR20');
  });

  it('is 302, never 301 — a cached permanent redirect could not be corrected', async () => {
    const res = await request(app).get(`/s/${activeSlug}`);
    expect(res.status).toBe(302);
    expect(res.status).not.toBe(301);
  });

  it('sends an unknown slug to the shop home instead of a 404', async () => {
    const res = await request(app).get(`/s/${TAG}-tidak-ada`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SHOP);
  });

  it('sends an inactive link to the shop home', async () => {
    const res = await request(app).get(`/s/${inactiveSlug}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SHOP);
  });

  it('sends a link whose product has no public reference to the shop home', async () => {
    const res = await request(app).get(`/s/${noRefSlug}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SHOP);
  });

  it('matches a slug case-insensitively (links get retyped from slides)', async () => {
    const res = await request(app).get(`/s/${activeSlug.toUpperCase()}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/product/');
  });

  describe('promo links', () => {
    async function mkPromo(slug: string): Promise<string> {
      const voucher = await prisma.voucher.create({
        data: { code: `${TAG.toUpperCase()}-${slug}`, type: 'PERCENT', value: 20 },
      });
      const promo = await prisma.promo.create({
        data: { slug: `${TAG}-${slug}`, title: `${TAG} ${slug}`, voucherId: voucher.id },
      });
      return promo.id;
    }

    it('lands on the promo page with the UTM set and no voucher param', async () => {
      const promoId = await mkPromo('oktober');
      const slug = `${TAG}-promo-wa`;
      await mkLink({ slug, promoId });

      const res = await request(app).get(`/s/${slug}`);
      expect(res.status).toBe(302);
      const target = new URL(res.headers.location);
      expect(target.origin).toBe(SHOP);
      expect(target.pathname).toBe(`/promo/${TAG}-oktober`);
      expect(target.searchParams.get('utm_source')).toBe('webinar');
      expect(target.searchParams.get('utm_campaign')).toBe(slug);
      // The promo page carries its own voucher onto every product link.
      expect(target.searchParams.get('voucher')).toBeNull();
    });

    it('sends a link whose promo was deleted to the shop home', async () => {
      const promoId = await mkPromo('dihapus');
      const slug = `${TAG}-promo-hilang`;
      await mkLink({ slug, promoId });
      await prisma.promo.delete({ where: { id: promoId } });

      const res = await request(app).get(`/s/${slug}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(SHOP);
    });

    it('rejects a link that targets both a product and a promo', async () => {
      const promoId = await mkPromo('ganda');
      await expect(mkLink({ slug: `${TAG}-ganda`, productId, promoId })).rejects.toThrow();
    });

    it('rejects a link that targets nothing', async () => {
      await expect(mkLink({ slug: `${TAG}-kosong` })).rejects.toThrow();
    });
  });

  describe('click counting', () => {
    it('counts one row per (link, WIB day) and increments it', async () => {
      const slug = `${TAG}-hitung`;
      const linkId = await mkLink({ slug, productId });

      await trackingLinkService.recordClick(linkId, 'Mozilla/5.0');
      await trackingLinkService.recordClick(linkId, 'Mozilla/5.0');

      const rows = await prisma.trackingLinkClick.findMany({ where: { linkId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.count).toBe(2);
    });

    it('does not count unfurl bots', async () => {
      const slug = `${TAG}-bot`;
      const linkId = await mkLink({ slug, productId });

      await trackingLinkService.recordClick(linkId, 'WhatsApp/2.23 A');
      expect(await prisma.trackingLinkClick.count({ where: { linkId } })).toBe(0);
    });

    it('puts 01:00 WIB on that night, not the previous day', async () => {
      const slug = `${TAG}-wib`;
      const linkId = await mkLink({ slug, productId });

      // 22:00 WIB on the 10th = 15:00 UTC the 10th.
      await trackingLinkService.recordClick(linkId, 'Mozilla/5.0', new Date('2026-08-10T15:00:00Z'));
      // 01:00 WIB on the 11th = 18:00 UTC the 10th — must land on the 11th.
      await trackingLinkService.recordClick(linkId, 'Mozilla/5.0', new Date('2026-08-10T18:00:00Z'));

      const rows = await prisma.trackingLinkClick.findMany({
        where: { linkId },
        orderBy: { day: 'asc' },
      });
      expect(rows.map((r) => r.day.toISOString().slice(0, 10))).toEqual(['2026-08-10', '2026-08-11']);
    });

    it('records a click through the HTTP route', async () => {
      const slug = `${TAG}-http`;
      const linkId = await mkLink({ slug, productId });

      await request(app).get(`/s/${slug}`).set('User-Agent', 'Mozilla/5.0');

      // The counter write is fire-and-forget by design, so the assertion polls
      // instead of sleeping a fixed amount: a hardcoded wait passes alone and
      // flakes inside the full suite, which is the worst kind of test.
      const total = await waitFor(async () => {
        const rows = await prisma.trackingLinkClick.findMany({ where: { linkId } });
        const sum = rows.reduce((a, r) => a + r.count, 0);
        return sum > 0 ? sum : null;
      });
      expect(total).toBe(1);
    });

    it('drops the counters when the link is deleted (cascade)', async () => {
      const slug = `${TAG}-cascade-${randomUUID().slice(0, 8)}`;
      const linkId = await mkLink({ slug, productId });
      await trackingLinkService.recordClick(linkId, 'Mozilla/5.0');
      expect(await prisma.trackingLinkClick.count({ where: { linkId } })).toBe(1);

      await prisma.trackingLink.delete({ where: { id: linkId } });
      linkIds.splice(linkIds.indexOf(linkId), 1);
      expect(await prisma.trackingLinkClick.count({ where: { linkId } })).toBe(0);
    });
  });
});
