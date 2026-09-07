import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { TrackingService } from '@/modules/tracker/tracking.service';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * Write-side half of the `course_id` mismatch (docs/tracker-streak.md §8b).
 *
 * The read path accepts both id spaces so the 171k existing rows work with no
 * backfill. This normalises at the source so NEW rows stop being wrong, which is
 * what lets the column converge on one id space over time — the Firebase backfill
 * script already writes a real `courses.id`, so client writes were the only
 * remaining producer of the wrong one.
 */
describe('TrackingService normalises course_id at write time (real Postgres)', () => {
  const tracking = new TrackingService();

  let memberId = '';
  let productId = '';
  let courseId = '';

  const readRow = (clientSessionId: string) =>
    prisma.listeningSession.findFirstOrThrow({
      where: { memberId, clientSessionId },
      select: { courseId: true, listenedSec: true },
    });

  const track = (clientSessionId: string, courseIdIn: string | null, listenedSec = 700) =>
    tracking.record(
      memberId,
      { clientSessionId, audioId: crypto.randomUUID(), courseId: courseIdIn, startedAt: new Date().toISOString(), listenedSec, completed: true },
      'ios',
    );

  beforeAll(async () => {
    const m = await prisma.member.create({
      data: { email: `cidnorm-${uid()}@test.local`, passwordHash: await bcrypt.hash('s', 4) },
    });
    memberId = m.id;
    productId = (await prisma.product.create({ data: { type: 'course', title: 'Normalise', code: `N-${uid()}` } })).id;
    courseId = (await prisma.course.create({ data: { productId, programDays: 30 } })).id;
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.course.delete({ where: { id: courseId } });
    await prisma.product.delete({ where: { id: productId } });
  });

  it('stores the courses.id when the client sends a products.id', async () => {
    const csid = crypto.randomUUID();
    await track(csid, productId);
    expect((await readRow(csid)).courseId).toBe(courseId);
  });

  it('leaves a courses.id untouched, so a corrected client is a no-op', async () => {
    const csid = crypto.randomUUID();
    await track(csid, courseId);
    expect((await readRow(csid)).courseId).toBe(courseId);
  });

  it('keeps an id that matches neither table verbatim, rather than nulling it', async () => {
    // This is an ingest log. Writing null would destroy the only evidence of what
    // the client actually sent, and the read path already ignores unknown ids.
    const orphan = crypto.randomUUID();
    const csid = crypto.randomUUID();
    await track(csid, orphan);
    expect((await readRow(csid)).courseId).toBe(orphan);
  });

  it('stores null for standalone listening', async () => {
    const csid = crypto.randomUUID();
    await track(csid, null);
    expect((await readRow(csid)).courseId).toBeNull();
  });

  it('keeps the normalised value when the same session is re-sent', async () => {
    // Pause→resume / offline flush re-sends the same clientSessionId. The upsert
    // update branch must not undo the normalisation the create branch applied.
    const csid = crypto.randomUUID();
    await track(csid, productId, 300);
    await track(csid, productId, 900);
    const row = await readRow(csid);
    expect(row.courseId).toBe(courseId);
    expect(row.listenedSec).toBe(900);
  });
});
