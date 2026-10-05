import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { BannerService, type BannerClientInfo } from '../src/modules/banner/banner.service';

const TAG = `bvw${Date.now().toString(36)}`;
const ALL = { page: 1, perPage: 100, skip: 0, take: 100 };

describe('BannerService per-banner version window', () => {
  const service = new BannerService();
  const ids: string[] = [];

  async function banner(suffix: string, data: Record<string, unknown> = {}) {
    const b = await prisma.banner.create({
      data: { title: `${TAG}-${suffix}`, imageUrl: 'x.jpg', ...data },
    });
    ids.push(b.id);
  }

  /** Titles of the tagged banners the client sees — the shared DB holds other banners. */
  async function seen(client?: BannerClientInfo): Promise<string[]> {
    const { rows } = await service.listActive(ALL, undefined, client);
    return rows.filter((r) => r.title.startsWith(TAG)).map((r) => r.title.slice(TAG.length + 1));
  }

  beforeAll(async () => {
    await banner('plain', { position: 1 });
    // Internal build 3.3.2+ only, on both platforms.
    await banner('internal', { position: 2, minVersionAndroid: '3.3.2', minVersionIos: '3.3.2' });
    // Android 3.3.0–3.3.1 only; iOS pair empty.
    await banner('android-range', {
      position: 3,
      minVersionAndroid: '3.3.0',
      maxVersionAndroid: '3.3.1',
    });
  });

  afterAll(async () => {
    await prisma.banner.deleteMany({ where: { id: { in: ids } } });
  });

  it('shows a banner without a window to everyone, as before', async () => {
    expect(await seen()).toContain('plain');
    expect(await seen({ platform: 'android', version: '1.0.0' })).toContain('plain');
  });

  it('shows a windowed banner only inside the window (bounds inclusive)', async () => {
    expect(await seen({ platform: 'android', version: '3.3.2' })).toContain('internal');
    expect(await seen({ platform: 'ios', version: '3.4.0' })).toContain('internal');
    expect(await seen({ platform: 'android', version: '3.3.1' })).not.toContain('internal');
    expect(await seen({ platform: 'android', version: '3.3.1' })).toContain('android-range');
    expect(await seen({ platform: 'android', version: '3.3.2' })).not.toContain('android-range');
  });

  it('treats an empty pair for the client platform as unbounded', async () => {
    expect(await seen({ platform: 'ios', version: '1.0.0' })).toContain('android-range');
  });

  it('fails closed without platform (web or a pre-gate app build)', async () => {
    expect(await seen()).toEqual(['plain']);
    expect(await seen({ platform: 'web', version: '9.9.9' })).toEqual(['plain']);
  });

  it('fails closed on mobile with a missing or unparseable version', async () => {
    expect(await seen({ platform: 'android' })).not.toContain('internal');
    expect(await seen({ platform: 'ios', version: 'nightly' })).not.toContain('internal');
  });

  it('counts total and pages after the window is applied', async () => {
    const client = { platform: 'android', version: '3.3.2' };
    const full = await service.listActive(ALL, undefined, client);
    const page = await service.listActive({ page: 1, perPage: 1, skip: 0, take: 1 }, undefined, client);
    expect(page.total).toBe(full.total);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].id).toBe(full.rows[0].id);
  });
});
