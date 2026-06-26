import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';
import { createTestMember, createTestProduct } from '../commerce/fixtures';

const svc = new ProductService();

// Unique token shared by this suite's product titles; passed as `keyword` on every
// `list` call so assertions are scoped to THESE products only (suite runs in
// parallel against a shared DB).
const KW = `fskw${Date.now().toString(36)}`;
const page = { page: 1, perPage: 50, skip: 0, take: 50 };

const productIds: string[] = [];
const courseIds: string[] = [];
const memberIds: string[] = [];

// Build a course with one section + one lesson whose `slidesData` holds the given
// slide template types, so the `media` JSONB scan has something to match.
async function makeCourseWithSlides(productId: string, slideTypes: string[]) {
  const course = await prisma.course.create({ data: { productId } });
  courseIds.push(course.id);
  const section = await prisma.courseSection.create({
    data: { courseId: course.id, name: 'S1', order: 0 },
  });
  await prisma.lesson.create({
    data: {
      sectionId: section.id,
      name: 'L1',
      order: 0,
      slidesData: slideTypes.map((type, i) => ({ id: `s${i}`, type, data: {} })),
    },
  });
  return course;
}

async function review(productId: string, stars: number, seed: string) {
  const m = await createTestMember(`fs-${seed}`);
  memberIds.push(m.id);
  await prisma.review.create({ data: { productId, memberId: m.id, stars } });
}

let audioId: string; // course, price 300k, audio only, rating 2
let videoId: string; // course, price 100k, video only, rating 5
let miniId: string; // mini_course, price 200k, audio+video, rating 4

describe('ProductService.list filter/sort', () => {
  beforeAll(async () => {
    const audio = await createTestProduct(`${KW} Audio Course`, 300_000);
    const video = await createTestProduct(`${KW} Video Course`, 100_000);
    const mini = await prisma.product.create({
      data: { type: 'mini_course', title: `${KW} Mini`, price: 200_000, isActive: true, status: 'active' },
    });
    audioId = audio.id;
    videoId = video.id;
    miniId = mini.id;
    productIds.push(audioId, videoId, miniId);

    await makeCourseWithSlides(audioId, ['AudioTemplate']);
    await makeCourseWithSlides(videoId, ['VideoTemplate']);
    await makeCourseWithSlides(miniId, ['AudioTemplate', 'VideoTemplate']);

    await review(audioId, 2, 'a');
    await review(videoId, 5, 'v');
    await review(miniId, 4, 'm');
  });

  afterAll(async () => {
    await prisma.review.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  it('type=mini_course → only the mini course', async () => {
    const r = await svc.list(page, { keyword: KW, type: 'mini_course' });
    expect(r.rows.map((p) => p.id)).toEqual([miniId]);
    expect(r.total).toBe(1);
  });

  it('sort=price_asc → cheapest first', async () => {
    const r = await svc.list(page, { keyword: KW, sort: 'price_asc' });
    const ours = r.rows.filter((p) => productIds.includes(p.id)).map((p) => p.id);
    expect(ours).toEqual([videoId, miniId, audioId]); // 100k, 200k, 300k
  });

  it('sort=price_desc → priciest first', async () => {
    const r = await svc.list(page, { keyword: KW, sort: 'price_desc' });
    const ours = r.rows.filter((p) => productIds.includes(p.id)).map((p) => p.id);
    expect(ours).toEqual([audioId, miniId, videoId]); // 300k, 200k, 100k
  });

  it('sort=top_rated → highest avg stars first', async () => {
    const r = await svc.list(page, { keyword: KW, sort: 'top_rated' });
    const ours = r.rows.filter((p) => productIds.includes(p.id)).map((p) => p.id);
    expect(ours).toEqual([videoId, miniId, audioId]); // 5, 4, 2
  });

  it('media=[audio] → products containing audio slides', async () => {
    const r = await svc.list(page, { keyword: KW, media: ['audio'] });
    expect(r.rows.map((p) => p.id).sort()).toEqual([audioId, miniId].sort());
    expect(r.total).toBe(2);
  });

  it('media=[video] → products containing video slides', async () => {
    const r = await svc.list(page, { keyword: KW, media: ['video'] });
    expect(r.rows.map((p) => p.id).sort()).toEqual([videoId, miniId].sort());
    expect(r.total).toBe(2);
  });

  it('media=[audio,video] → OR semantics (all three)', async () => {
    const r = await svc.list(page, { keyword: KW, media: ['audio', 'video'] });
    expect(r.rows.map((p) => p.id).sort()).toEqual([audioId, videoId, miniId].sort());
    expect(r.total).toBe(3);
  });

  it('media + sort=top_rated combine (audio products, best rated first)', async () => {
    const r = await svc.list(page, { keyword: KW, media: ['audio'], sort: 'top_rated' });
    const ours = r.rows.filter((p) => productIds.includes(p.id)).map((p) => p.id);
    expect(ours).toEqual([miniId, audioId]); // 4 then 2
  });
});
