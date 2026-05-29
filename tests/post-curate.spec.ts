import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { PostService } from '@/modules/post/post.service';
import { NotFoundException } from '@/common/exceptions';
import { parsePagination } from '@/common/utils/pagination.util';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

describe('PostService.setCurated', () => {
  const postService = new PostService();
  let memberId = '';
  let postId = '';

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `curate-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
    const p = await prisma.post.create({
      data: {
        authorId: memberId,
        content: `curation candidate ${uid()}`,
        publishStatus: 'PUBLISHED',
      },
    });
    postId = p.id;
  });

  afterAll(async () => {
    await prisma.post.deleteMany({ where: { authorId: memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  it('flips isCurated true then false', async () => {
    const on = await postService.setCurated(postId, true);
    expect(on.isCurated).toBe(true);
    const off = await postService.setCurated(postId, false);
    expect(off.isCurated).toBe(false);
  });

  it('list with filter=curated returns only curated posts', async () => {
    await postService.setCurated(postId, true);
    const p = parsePagination({ page: '1', perPage: '50' });
    const { rows } = await postService.list(p, { filter: 'curated', viewerId: memberId });
    expect(rows.some((r) => r.id === postId)).toBe(true);
    expect(rows.every((r) => r.isCurated)).toBe(true);
  });

  it('throws NotFoundException on unknown id', async () => {
    await expect(
      postService.setCurated('00000000-0000-7000-8000-000000000000', true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
