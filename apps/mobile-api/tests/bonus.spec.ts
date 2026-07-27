import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import type { S3StorageService } from '@bb/common/services/s3-storage.service';
import { BonusService } from '@/modules/bonus/bonus.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

// Stub storage: echo the key + ttl so we can assert what was presigned, without
// needing real S3 credentials in the test env.
let lastPresign: { key: string; ttl: number } | null = null;
const stubStorage = {
  getPresignedGetUrl: async (key: string, ttl: number) => {
    lastPresign = { key, ttl };
    return `signed://${key}?exp=${ttl}`;
  },
} as unknown as S3StorageService;

describe('BonusService.getAccessUrl — course-access-gated presigned URL (real Postgres)', () => {
  const service = new BonusService(stubStorage);

  let enrolledMember = '';
  let strangerMember = '';
  let productId = '';
  let courseId = '';
  let bonusId = '';
  let inactiveBonusId = '';
  const fileKey = () => `private/course-bonus/${courseId}/${uid()}.pdf`;

  beforeAll(async () => {
    enrolledMember = (await prisma.member.create({ data: { email: `bon-e-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) } })).id;
    strangerMember = (await prisma.member.create({ data: { email: `bon-s-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) } })).id;

    productId = (await prisma.product.create({ data: { type: 'course', title: 'Bonus Course', code: `BON-${uid()}` } })).id;
    courseId = (await prisma.course.create({ data: { productId, programDays: 30 } })).id;

    // Only the enrolled member gets a retail enrollment.
    await prisma.courseEnrollment.create({ data: { memberId: enrolledMember, courseId } });

    bonusId = (await prisma.courseBonus.create({
      data: { courseId, title: 'Workbook', fileName: 'wb.pdf', fileKey: fileKey(), sizeBytes: 1234 },
    })).id;
    inactiveBonusId = (await prisma.courseBonus.create({
      data: { courseId, title: 'Hidden', fileName: 'hidden.pdf', fileKey: fileKey(), sizeBytes: 10, isActive: false },
    })).id;
  });

  afterAll(async () => {
    await prisma.courseBonus.deleteMany({ where: { courseId } });
    await prisma.courseEnrollment.deleteMany({ where: { courseId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.member.deleteMany({ where: { id: { in: [enrolledMember, strangerMember] } } });
    await prisma.$disconnect();
  });

  it('mints a presigned URL for an enrolled member', async () => {
    lastPresign = null;
    const res = await service.getAccessUrl(enrolledMember, bonusId);
    expect(res.expiresInSec).toBe(env.s3.presignExpires);
    expect(res.url).toContain('private/course-bonus/');
    // presigned against the bonus's own private fileKey + the configured TTL
    expect(lastPresign?.key).toMatch(/^private\/course-bonus\//);
    expect(lastPresign?.ttl).toBe(env.s3.presignExpires);
  });

  it('denies (403) a member with no access to the course — server-side gate', async () => {
    await expect(service.getAccessUrl(strangerMember, bonusId)).rejects.toThrow(/not enrolled/i);
  });

  it('404s an unknown bonus id', async () => {
    await expect(service.getAccessUrl(enrolledMember, crypto.randomUUID())).rejects.toThrow(/not found/i);
  });

  it('404s an inactive bonus (soft-hidden)', async () => {
    await expect(service.getAccessUrl(enrolledMember, inactiveBonusId)).rejects.toThrow(/not found/i);
  });
});
