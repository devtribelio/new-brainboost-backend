import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@bb/db';
import { buildApp } from '../src/app';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * `listening_session.source` is filled from the `x-platform` request header and from
 * nothing else. It went untested until now, which is uncomfortable given its history:
 * the old exact-match whitelist silently nulled every value the app actually sent, the
 * column sat empty in production for months, and it only surfaced when someone needed
 * to check "streak broke after the update" against the data and found none.
 *
 * A parser that fails by writing NULL, on a request that still answers 200, cannot be
 * noticed in the wild. These pin it.
 */
describe('x-platform → listening_session.source (HTTP, real Postgres)', () => {
  const app = buildApp();
  const PASSWORD = 'PlatformPass123';
  let accessToken = '';
  let memberId = '';

  /** POST a session with the given header (omitted when null) and read `source` back. */
  async function sourceFor(platform: string | null): Promise<string | null> {
    const clientSessionId = crypto.randomUUID();
    const req = request(app)
      .post('/api/tracking/session')
      .set('Authorization', `Bearer ${accessToken}`);
    if (platform !== null) req.set('x-platform', platform);

    const res = await req.send({
      clientSessionId,
      audioId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      listenedSec: 120,
      completed: false,
    });
    expect(res.status).toBe(200);

    const row = await prisma.listeningSession.findFirstOrThrow({
      where: { memberId, clientSessionId },
      select: { source: true },
    });
    return row.source;
  }

  beforeAll(async () => {
    const email = `platform-${uid()}@test.local`;
    const m = await prisma.member.create({
      data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), isEmailVerified: true },
    });
    memberId = m.id;

    const res = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password: PASSWORD });
    expect(res.status).toBe(200);
    accessToken = res.body.data.access_token as string;
  });

  afterAll(async () => {
    await prisma.listeningSession.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
  });

  it('stores a bare platform verbatim', async () => {
    expect(await sourceFor('ios')).toBe('ios');
    expect(await sourceFor('android')).toBe('android');
  });

  it('stores platform + version + build, which is the whole point of the column', async () => {
    // Without the build, a report of "streak broke after the update" cannot be checked
    // against the data at all — exactly what happened in Aug 2026.
    expect(await sourceFor('android/3.3.1+412')).toBe('android/3.3.1+412');
    expect(await sourceFor('ios/3.3.1+412')).toBe('ios/3.3.1+412');
  });

  it('trims surrounding whitespace rather than rejecting the value', async () => {
    expect(await sourceFor('  ios  ')).toBe('ios');
  });

  it('is case-sensitive — a capitalised platform is silently dropped', async () => {
    // Documented so the client is told, not discovered again from an empty column.
    expect(await sourceFor('iOS')).toBeNull();
    expect(await sourceFor('Android')).toBeNull();
  });

  it('rejects a separator that is not a slash', async () => {
    expect(await sourceFor('android 3.3.1')).toBeNull();
    expect(await sourceFor('android-3.3.1')).toBeNull();
    expect(await sourceFor('android:3.3.1')).toBeNull();
  });

  it('rejects an unknown platform', async () => {
    expect(await sourceFor('web')).toBeNull();
    expect(await sourceFor('flutter/android')).toBeNull();
  });

  it('refuses to let a client forge a synthetic marker', async () => {
    // `source` also carries `backfill:*` / `goodwill:*`, written by ops scripts. If a
    // request header could set those, a member could disguise their own rows as
    // recovered data — which is precisely what an audit of the Aug 2026 incident
    // would have to trust.
    expect(await sourceFor('backfill:firebase:2026-08')).toBeNull();
    expect(await sourceFor('goodwill:incident')).toBeNull();
  });

  it('caps the build suffix at 32 chars — counted after the slash', async () => {
    expect(await sourceFor(`android/${'9'.repeat(32)}`)).toBe(`android/${'9'.repeat(32)}`);
    expect(await sourceFor(`android/${'9'.repeat(33)}`)).toBeNull();
  });

  it('stores null when the header is absent', async () => {
    expect(await sourceFor(null)).toBeNull();
  });

  it('lets a later flush overwrite the recording build (current behaviour)', async () => {
    // Pinned, not endorsed. `source` sits in the upsert's update branch, so a session
    // recorded on build 411 and flushed after an upgrade is stored as 412 — the
    // opposite of what version forensics wants. Making it create-only (like `localDay`
    // and `courseId`) should be a deliberate change, which is why this is here.
    const clientSessionId = crypto.randomUUID();
    const body = {
      clientSessionId,
      audioId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      listenedSec: 60,
      completed: false,
    };
    const post = (platform: string, listenedSec: number) =>
      request(app)
        .post('/api/tracking/session')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-platform', platform)
        .send({ ...body, listenedSec });

    expect((await post('android/3.3.1+411', 60)).status).toBe(200);
    expect((await post('android/3.3.2+412', 900)).status).toBe(200);

    const row = await prisma.listeningSession.findFirstOrThrow({
      where: { memberId, clientSessionId },
      select: { source: true, listenedSec: true },
    });
    expect(row.source).toBe('android/3.3.2+412');
    expect(row.listenedSec).toBe(900);
  });
});
