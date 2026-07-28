import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { PostService } from '@bb/domain/post/post.service';
import { PostKindService } from '@/modules/post-kind/post-kind.service';
import { sweepOrphanUploads } from '@bb/domain/jobs/sweep-orphan-uploads';
import {
  recordUpload,
  markUploadsReferenced,
} from '@bb/common/services/upload-registry.service';
import type { S3StorageService } from '@bb/common/services/s3-storage.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

const DEFAULT_KIND_ID = '01991a00-0000-7000-8000-000000000003'; // Diskusi (seeded)
const TIPS_KIND_ID = '01991a00-0000-7000-8000-000000000002';

// ── Post kind taxonomy (§4) ───────────────────────────────────────────────────
describe('Post kinds (real Postgres)', () => {
  const posts = new PostService();
  const kinds = new PostKindService();
  let memberId = '';
  const createdPostIds: string[] = [];

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `kind-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
  });

  afterAll(async () => {
    await prisma.post.deleteMany({ where: { authorId: memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('lists the seeded kinds in display order, active only', async () => {
    const items = await kinds.list();
    expect(items.map((i) => i.name)).toEqual(['Testimoni', 'Tips', 'Diskusi', 'Progress', 'Tanya']);
    // ids are fixed across environments — FE caches them
    expect(items.find((i) => i.name === 'Diskusi')!.kindId).toBe(DEFAULT_KIND_ID);
  });

  it('applies the default kind when kindId is omitted (old app versions keep working)', async () => {
    const post = await posts.create(memberId, { content: `no kind ${uid()}` });
    createdPostIds.push(post.id);
    expect(post.kindId).toBe(DEFAULT_KIND_ID);
  });

  it('honours an explicit kindId', async () => {
    const post = await posts.create(memberId, { content: `tips ${uid()}`, kindId: TIPS_KIND_ID });
    createdPostIds.push(post.id);
    expect(post.kindId).toBe(TIPS_KIND_ID);
  });

  it('rejects an unknown kindId', async () => {
    await expect(
      posts.create(memberId, { content: `bad kind ${uid()}`, kindId: crypto.randomUUID() }),
    ).rejects.toThrow(/kind not available/i);
  });

  it('rejects an inactive kind', async () => {
    const inactive = await prisma.postKind.create({
      data: { name: 'Arsip', slug: `arsip-${uid()}`, isActive: false },
    });
    await expect(
      posts.create(memberId, { content: `inactive ${uid()}`, kindId: inactive.id }),
    ).rejects.toThrow(/kind not available/i);
    await prisma.postKind.delete({ where: { id: inactive.id } });
  });
});

// ── Excerpt derivation (§4) ───────────────────────────────────────────────────
describe('Post excerpt (real Postgres)', () => {
  const posts = new PostService();
  let memberId = '';

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `exc-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
  });

  afterAll(async () => {
    await prisma.post.deleteMany({ where: { authorId: memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('derives excerpt from the first 200 chars when absent', async () => {
    const content = `${'x'.repeat(250)} ${uid()}`;
    const post = await posts.create(memberId, { content });
    expect(post.excerpt).toBe(content.slice(0, 200));
  });

  it('keeps a client-supplied excerpt', async () => {
    const post = await posts.create(memberId, {
      content: `long body ${uid()}`,
      excerpt: 'Ringkasan manual',
    });
    expect(post.excerpt).toBe('Ringkasan manual');
  });
});

// ── Upload registry + orphan sweep (§4) ───────────────────────────────────────
describe('Upload registry + orphan sweep (real Postgres)', () => {
  const posts = new PostService();
  let memberId = '';
  const keys: string[] = [];

  // Fake storage: records deletes instead of hitting S3.
  const deletedKeys: string[] = [];
  const fakeStorage = {
    deleteObject: async (key: string) => {
      deletedKeys.push(key);
    },
  } as unknown as S3StorageService;

  function newKey(kind = 'post'): string {
    const k = `public/${kind}s/${memberId}/${uid()}.webp`;
    keys.push(k);
    return k;
  }
  async function seedUpload(key: string, kind: string, createdAt: Date) {
    await recordUpload({
      key,
      publicUrl: `https://cdn.test/${key}`,
      ownerId: memberId,
      kind,
      fileName: 'x.png',
      mimeType: 'image/webp',
      sizeBytes: 100,
    });
    await prisma.uploadedFile.update({ where: { key }, data: { createdAt } });
  }

  const old = new Date(Date.now() - 30 * 86_400_000); // well past any TTL
  const now = new Date();

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `upl-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
  });

  afterAll(async () => {
    await prisma.uploadedFile.deleteMany({ where: { ownerId: memberId } });
    await prisma.post.deleteMany({ where: { authorId: memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('records an upload as unreferenced', async () => {
    const key = newKey();
    await seedUpload(key, 'post', now);
    const row = await prisma.uploadedFile.findUnique({ where: { key } });
    expect(row).toMatchObject({ ownerId: memberId, kind: 'post', referencedAt: null });
  });

  it('marks referenced by object key AND by public URL (client may send either)', async () => {
    const byKey = newKey();
    const byUrl = newKey();
    await seedUpload(byKey, 'post', now);
    await seedUpload(byUrl, 'post', now);

    await markUploadsReferenced([byKey, `https://cdn.test/${byUrl}`], 'post', crypto.randomUUID());

    const rows = await prisma.uploadedFile.findMany({ where: { key: { in: [byKey, byUrl] } } });
    expect(rows.every((r) => r.referencedAt !== null)).toBe(true);
    expect(rows.every((r) => r.referenceType === 'post')).toBe(true);
  });

  it('creating a post claims the uploads it references', async () => {
    const key = newKey();
    await seedUpload(key, 'post', now);

    const post = await posts.create(memberId, {
      content: `with image ${uid()}`,
      imageUrls: [`https://cdn.test/${key}`],
    });

    const row = await prisma.uploadedFile.findUnique({ where: { key } });
    expect(row!.referencedAt).not.toBeNull();
    expect(row!.referenceId).toBe(post.id);
  });

  it('sweeps only unreferenced post uploads past the TTL', async () => {
    deletedKeys.length = 0;

    const orphanOld = newKey(); // → swept
    const orphanFresh = newKey(); // too new → kept
    const claimedOld = newKey(); // referenced → kept
    const avatarOld = newKey('avatar'); // wrong kind → kept (its consumer never claims)

    await seedUpload(orphanOld, 'post', old);
    await seedUpload(orphanFresh, 'post', now);
    await seedUpload(claimedOld, 'post', old);
    await seedUpload(avatarOld, 'avatar', old);
    await markUploadsReferenced([claimedOld], 'post', crypto.randomUUID());

    const res = await sweepOrphanUploads(new Date(), 168, fakeStorage);

    expect(deletedKeys).toContain(orphanOld);
    expect(deletedKeys).not.toContain(orphanFresh);
    expect(deletedKeys).not.toContain(claimedOld);
    expect(deletedKeys).not.toContain(avatarOld); // ← guards live avatars
    expect(res.deleted).toBeGreaterThanOrEqual(1);

    // Row removed only for the swept object; the others survive.
    expect(await prisma.uploadedFile.findUnique({ where: { key: orphanOld } })).toBeNull();
    expect(await prisma.uploadedFile.findUnique({ where: { key: orphanFresh } })).not.toBeNull();
    expect(await prisma.uploadedFile.findUnique({ where: { key: claimedOld } })).not.toBeNull();
    expect(await prisma.uploadedFile.findUnique({ where: { key: avatarOld } })).not.toBeNull();
  });

  it('keeps the row when the S3 delete fails, so the next run retries', async () => {
    const key = newKey();
    await seedUpload(key, 'post', old);
    const failingStorage = {
      deleteObject: async () => {
        throw new Error('s3 down');
      },
    } as unknown as S3StorageService;

    const res = await sweepOrphanUploads(new Date(), 168, failingStorage);

    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(await prisma.uploadedFile.findUnique({ where: { key } })).not.toBeNull();
  });
});
