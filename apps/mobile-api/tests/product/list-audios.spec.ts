import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { ProductService } from '@/modules/product/product.service';
import { listAddableAudios } from '@/modules/media/media-asset.util';
import { serializeProduct } from '@/modules/product/product.serializer';
import { createTestProduct } from '../commerce/fixtures';

const svc = new ProductService();

describe('listAddableAudios', () => {
  const guid = { guid: 'g-1' };

  it('keeps AudioTemplate slides with a guid, in authoring order', () => {
    const r = listAddableAudios([
      { id: 'a1', type: 'AudioTemplate', data: { ...guid, title: 'Satu', durationSec: 60 } },
      { id: 'a2', type: 'AudioTemplate', data: { ...guid, title: 'Dua', durationSec: 90 } },
    ]);
    expect(r).toEqual([
      { audioId: 'a1', title: 'Satu', durationSec: 60 },
      { audioId: 'a2', title: 'Dua', durationSec: 90 },
    ]);
  });

  it('drops video, bonus, id-less and guid-less slides', () => {
    const r = listAddableAudios([
      { id: 'v1', type: 'VideoTemplate', data: { ...guid, title: 'Video' } },
      { id: 'b1', type: 'AudioTemplate', bonus: true, data: { ...guid, title: 'Bonus' } },
      { type: 'AudioTemplate', data: { ...guid, title: 'No id' } },
      { id: 'n1', type: 'AudioTemplate', data: { title: 'No guid' } },
      { id: 'ok', type: 'AudioTemplate', data: { ...guid } },
    ]);
    expect(r).toEqual([{ audioId: 'ok', title: null, durationSec: 0 }]);
  });

  it('is empty for a non-array', () => {
    expect(listAddableAudios(null)).toEqual([]);
    expect(listAddableAudios({})).toEqual([]);
  });
});

describe('ProductService.batchAudios (real Postgres)', () => {
  const productIds: string[] = [];
  const courseIds: string[] = [];
  let withAudio: string;
  let withoutAudio: string;

  beforeAll(async () => {
    const a = await createTestProduct(`la-audio-${Date.now()}`, 100_000);
    const b = await createTestProduct(`la-none-${Date.now()}`, 100_000);
    withAudio = a.id;
    withoutAudio = b.id;
    productIds.push(a.id, b.id);

    const course = await prisma.course.create({ data: { productId: a.id } });
    courseIds.push(course.id);
    // Sections and lessons created out of order on purpose: the output must follow
    // section.order then lesson.order, not insertion.
    const s2 = await prisma.courseSection.create({ data: { courseId: course.id, name: 'S2', order: 2 } });
    const s1 = await prisma.courseSection.create({ data: { courseId: course.id, name: 'S1', order: 1 } });
    await prisma.lesson.create({
      data: {
        sectionId: s2.id,
        name: 'Lesson S2',
        order: 1,
        slidesData: [{ id: 'aud-s2', type: 'AudioTemplate', data: { guid: 'g3', title: 'Tiga', durationSec: 30 } }],
      },
    });
    await prisma.lesson.create({
      data: {
        sectionId: s1.id,
        name: 'Lesson S1 b',
        order: 2,
        slidesData: [{ id: 'aud-s1b', type: 'AudioTemplate', data: { guid: 'g2' } }], // no title → lesson name
      },
    });
    await prisma.lesson.create({
      data: {
        sectionId: s1.id,
        name: 'Lesson S1 a',
        order: 1,
        slidesData: [
          { id: 'vid-s1a', type: 'VideoTemplate', data: { guid: 'gv' } },
          { id: 'aud-s1a', type: 'AudioTemplate', data: { guid: 'g1', title: 'Satu', durationSec: 10 } },
        ],
      },
    });
    await prisma.lesson.create({
      data: {
        sectionId: s1.id,
        name: 'Archived',
        order: 3,
        lessonStatus: 'ARCHIVED',
        slidesData: [{ id: 'aud-archived', type: 'AudioTemplate', data: { guid: 'gx', title: 'Arsip' } }],
      },
    });

    const course2 = await prisma.course.create({ data: { productId: b.id } });
    courseIds.push(course2.id);
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  });

  it('lists addable audio per product in section/lesson/slide order, lesson name as title fallback', async () => {
    const map = await svc.batchAudios([withAudio, withoutAudio]);
    expect(map.get(withAudio)).toEqual([
      { id: 'aud-s1a', title: 'Satu', durationSec: 10 },
      { id: 'aud-s1b', title: 'Lesson S1 b', durationSec: 0 },
      { id: 'aud-s2', title: 'Tiga', durationSec: 30 },
    ]);
    // A course with no audio is simply absent from the map; the controller emits [].
    expect(map.has(withoutAudio)).toBe(false);
  });

  it('emits `audios` only when the serializer is given one', async () => {
    const p = await prisma.product.findUniqueOrThrow({ where: { id: withAudio } });
    expect(serializeProduct(p)).not.toHaveProperty('audios');
    expect(serializeProduct(p, { audios: [] })).toMatchObject({ audios: [] });
  });
});
