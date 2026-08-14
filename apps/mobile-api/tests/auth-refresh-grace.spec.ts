import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

/**
 * Refresh-token grace window + `superseded_by_id` lineage.
 *
 * The bug this closes: rotation used to be instantly terminal, so a refresh
 * whose response never reached the client (flaky mobile network), or a second
 * parallel refresh, or a request still in flight on the pre-rotation access
 * token, all came back 401 and the app logged the user out for no reason.
 *
 * The load-bearing distinction throughout: a row revoked BY ROTATION carries
 * `supersededById` and is replayable for a short window; a row revoked because
 * the session was deliberately ended does not, and still kicks instantly.
 */
describe('auth refresh grace window', () => {
  const email = `refresh-grace-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'secret123';
  const app = buildApp();
  let memberId: string;

  beforeAll(async () => {
    await request(app).post('/api/member/auth/register').send({
      email,
      password,
      fullName: 'Refresh Grace Tester',
    });
    const member = await prisma.member.update({
      where: { email },
      data: { isActive: true, isEmailVerified: true },
    });
    memberId = member.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { memberId } });
    await prisma.member.delete({ where: { id: memberId } });
    await prisma.$disconnect();
  });

  async function loginPassword() {
    const res = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'password', username: email, password });
    expect(res.status).toBe(200);
    return res.body.data as { access_token: string; refresh_token: string };
  }

  function refresh(refreshToken: string) {
    return request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  function profile(accessToken: string) {
    return request(app)
      .get('/api/member/account/profile/info')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  async function ageOutOfGrace(refreshToken: string) {
    await prisma.refreshToken.update({
      where: { token: refreshToken },
      data: { revokedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
  }

  const liveCount = () => prisma.refreshToken.count({ where: { memberId, revokedAt: null } });

  it('replaying a rotated token inside the window returns the successor pair, idempotently', async () => {
    const a = await loginPassword();

    const first = await refresh(a.refresh_token);
    expect(first.status).toBe(200);
    const child = first.body.data.refresh_token as string;

    // This is the lost-response case: the client never saw `first`, so it
    // retries with the token it still holds. It must get the same pair back.
    const replay = await refresh(a.refresh_token);
    expect(replay.status).toBe(200);
    expect(replay.body.data.refresh_token).toBe(child);

    // Replay is idempotent — no extra session row is minted per attempt.
    const again = await refresh(a.refresh_token);
    expect(again.status).toBe(200);
    expect(again.body.data.refresh_token).toBe(child);
  });

  it('two parallel refreshes both succeed and mint exactly one successor', async () => {
    const a = await loginPassword();
    const before = await liveCount();

    const [one, two] = await Promise.all([refresh(a.refresh_token), refresh(a.refresh_token)]);

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    // Both callers converge on the same successor: the loser of the rotation
    // gate replays the winner's child rather than minting a rival session.
    expect(one.body.data.refresh_token).toBe(two.body.data.refresh_token);
    expect(await liveCount()).toBe(before);
  });

  it('an access token whose sid was just superseded still passes authGuard', async () => {
    const a = await loginPassword();
    const rotated = await refresh(a.refresh_token);
    expect(rotated.status).toBe(200);

    // The rotation tail: requests already in flight carry the pre-rotation
    // access token, whose JWT is nowhere near expiry.
    const stale = await profile(a.access_token);
    expect(stale.status).toBe(200);

    const fresh = await profile(rotated.body.data.access_token);
    expect(fresh.status).toBe(200);
  });

  it('the access token stops working once the window has passed', async () => {
    const a = await loginPassword();
    await refresh(a.refresh_token);

    await ageOutOfGrace(a.refresh_token);
    const stale = await profile(a.access_token);
    expect(stale.status).toBe(401);
  });

  it('replaying outside the window is SESSION_REVOKED', async () => {
    const a = await loginPassword();
    await refresh(a.refresh_token);

    await ageOutOfGrace(a.refresh_token);
    const replay = await refresh(a.refresh_token);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');
  });

  it('walks the lineage forward when the successor has itself been rotated', async () => {
    const a = await loginPassword();
    const child = await refresh(a.refresh_token);
    const grandchild = await refresh(child.body.data.refresh_token);
    expect(grandchild.status).toBe(200);

    // The client is two generations behind — the winner refreshed again while
    // this one was retrying. It should still land on the live session.
    const replay = await refresh(a.refresh_token);
    expect(replay.status).toBe(200);
    expect(replay.body.data.refresh_token).toBe(grandchild.body.data.refresh_token);
  });

  it('logout revokes without a successor, so grace does not apply', async () => {
    const a = await loginPassword();

    const logout = await request(app)
      .post('/api/member/account/logout')
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({});
    expect(logout.status).toBe(200);

    // No grace: the row was revoked deliberately, not rotated.
    const replay = await refresh(a.refresh_token);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');
    expect(await profile(a.access_token)).toHaveProperty('status', 401);

    const row = await prisma.refreshToken.findUnique({ where: { token: a.refresh_token } });
    expect(row?.revokedAt).toBeTruthy();
    expect(row?.supersededById).toBeNull();
  });

  it('single-session kick revokes without a successor, so grace does not apply', async () => {
    const a = await loginPassword();
    await loginPassword(); // device B kicks A

    const replay = await refresh(a.refresh_token);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');

    const row = await prisma.refreshToken.findUnique({ where: { token: a.refresh_token } });
    expect(row?.supersededById).toBeNull();
  });

  it('grace replay is refused for a deactivated member', async () => {
    const a = await loginPassword();
    await refresh(a.refresh_token);

    await prisma.member.update({ where: { id: memberId }, data: { isActive: false } });
    try {
      const replay = await refresh(a.refresh_token);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('SESSION_REVOKED');
    } finally {
      await prisma.member.update({ where: { id: memberId }, data: { isActive: true } });
    }
  });

  it('rotation records the lineage pointer', async () => {
    const a = await loginPassword();
    const rotated = await refresh(a.refresh_token);

    const parent = await prisma.refreshToken.findUnique({ where: { token: a.refresh_token } });
    const child = await prisma.refreshToken.findUnique({
      where: { token: rotated.body.data.refresh_token },
    });
    expect(parent?.revokedAt).toBeTruthy();
    expect(parent?.supersededById).toBe(child?.id);
  });
});
