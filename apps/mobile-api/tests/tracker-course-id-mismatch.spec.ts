import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { TrackingService } from '@/modules/tracker/tracking.service';
import { StatsService } from '@/modules/tracker/stats.service';
import { addDays, toListeningDayWIB } from '@/modules/tracker/tracker.time';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function noonWibOf(day: Date): Date {
  return new Date(day.getTime() + 5 * 3_600_000);
}

/**
 * `listening_session.course_id` holds a `products.id`, not a `courses.id`
 * (docs/tracker-streak.md §8b BUG-1). Measured on prod 2026-08-31: 171,087 of
 * 171,087 rows fail to match any `courses.id` while 171,084 match a `products.id`.
 *
 * The client is sending the wrong field. Every id this API hands it for the purpose
 * is a real course id — `product.dto.ts` documents `courseId` as the Course UUID and
 * says to pass it to `/user/stats/course/:courseId`, and the playlist serializer
 * emits `lesson.section.courseId` — so the column name and the join are right and
 * the data is wrong.
 *
 * The existing tracker specs cannot catch this: they write and read the same id, so
 * they are self-consistent whichever id space that is. These write with the id the
 * REAL client sends and read with the id the real client is given.
 */
describe('per-course stats survive the products.id / courses.id mismatch (real Postgres)', () => {
  const tracking = new TrackingService();
  const stats = new StatsService();

  let memberId = '';
  let productId = '';
  let courseId = '';
  /** A second program the client tracks with the CORRECT id, as a fixed client would. */
  let fixedProductId = '';
  let fixedCourseId = '';

  const today = toListeningDayWIB(new Date());

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `cidmix-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;

    productId = (await prisma.product.create({ data: { type: 'course', title: 'Mismatch A', code: `MA-${uid()}` } })).id;
    courseId = (await prisma.course.create({ data: { productId, programDays: 30 } })).id;
    fixedProductId = (await prisma.product.create({ data: { type: 'course', title: 'Mismatch B', code: `MB-${uid()}` } })).id;
    fixedCourseId = (await prisma.course.create({ data: { productId: fixedProductId, programDays: 30 } })).id;

    await prisma.courseEnrollment.createMany({
      data: [
        { memberId, courseId },
        { memberId, courseId: fixedCourseId },
      ],
    });

    // Two consecutive qualifying days, tracked the way the real client tracks them:
    // with the PRODUCT id in a field named `courseId`.
    for (const back of [0, 1]) {
      await tracking.record(
        memberId,
        { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: productId, startedAt: noonWibOf(addDays(today, -back)).toISOString(), listenedSec: 700, completed: true },
        'ios',
      );
    }

    // The same, but with the id a corrected client would send. Both must bucket.
    await tracking.record(
      memberId,
      { clientSessionId: crypto.randomUUID(), audioId: crypto.randomUUID(), courseId: fixedCourseId, startedAt: noonWibOf(today).toISOString(), listenedSec: 700, completed: true },
      'ios',
    );
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.course.deleteMany({ where: { id: { in: [courseId, fixedCourseId] } } });
    await prisma.product.deleteMany({ where: { id: { in: [productId, fixedProductId] } } });
  });

  it('counts a challenge tracked with the product id', async () => {
    const res = await stats.home(memberId);
    const challenge = res.challenges.find((c) => c.courseId === courseId);
    expect(challenge).toBeDefined();
    // Two consecutive qualifying days. Zero here is the bug: the join never matched.
    expect(challenge!.day).toBe(2);
  });

  it('counts a challenge tracked with the course id, so a fixed client keeps working', async () => {
    const res = await stats.home(memberId);
    expect(res.challenges.find((c) => c.courseId === fixedCourseId)!.day).toBe(1);
  });

  it('still reports challenges keyed by the COURSE id the client is given', async () => {
    const res = await stats.home(memberId);
    const keys = res.challenges.map((c) => c.courseId).sort();
    // The response contract is unchanged — the product id is a join key, never output.
    expect(keys).toEqual([courseId, fixedCourseId].sort());
    expect(keys).not.toContain(productId);
  });

  it('does not leak one program listening into another', async () => {
    const res = await stats.home(memberId);
    // Program B has one qualifying day, program A has two. A shared bucket would
    // give both the same number.
    expect(res.challenges.find((c) => c.courseId === courseId)!.day).not.toBe(
      res.challenges.find((c) => c.courseId === fixedCourseId)!.day,
    );
  });

  it('serves courseStats for a course whose sessions were tracked with the product id', async () => {
    // The route takes the courses.id — that is what `product.dto.ts` hands the client.
    const res = await stats.courseStats(memberId, courseId);
    expect(res.daysListened).toBe(2);
    expect(res.totalListenSec).toBe(1400);
    expect(res.lastListenedAt).not.toBeNull();
  });

  it('serves courseStats for a course tracked with the course id', async () => {
    const res = await stats.courseStats(memberId, fixedCourseId);
    expect(res.daysListened).toBe(1);
    expect(res.totalListenSec).toBe(700);
  });

  it('keeps the global streak independent of any of this', async () => {
    // The global streak never filtered on courseId, which is why nothing looked
    // broken while every challenge card read 0.
    const res = await stats.home(memberId);
    expect(res.streakDays).toBe(2);
  });
});
