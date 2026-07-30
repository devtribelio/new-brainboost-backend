import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';
import { prisma } from '@bb/db';

const app = buildApp();
const createdMemberIds: string[] = [];

/**
 * Fresh member per test — changePassword mutates the credential, so sharing one
 * member across cases would couple them to execution order.
 */
async function makeMember(password: string) {
  const email = `chpw-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  await request(app)
    .post('/api/member/auth/register')
    .send({ email, password, fullName: 'ChangePassword Tester' });
  // Register leaves the member inactive behind the verify-email gate; activate
  // directly — OTP delivery is not what this suite tests.
  await prisma.member.update({
    where: { email },
    data: { isActive: true, isEmailVerified: true },
  });
  const member = await prisma.member.findUnique({ where: { email } });
  expect(member).toBeTruthy();
  createdMemberIds.push(member!.id);
  return { email, id: member!.id };
}

/** `client_type: 'web'` = multi-session bucket, so two logins can coexist. */
async function login(email: string, password: string) {
  const res = await request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password, client_type: 'web' });
  return res;
}

async function loginOk(email: string, password: string) {
  const res = await login(email, password);
  expect(res.status).toBe(200);
  return res.body.data as { access_token: string; refresh_token: string };
}

function changePassword(accessToken: string, body: Record<string, string>) {
  return request(app)
    .post('/api/member/account/changePassword')
    .set('Authorization', `Bearer ${accessToken}`)
    .send(body);
}

function profileInfo(accessToken: string) {
  return request(app)
    .get('/api/member/account/profile/info')
    .set('Authorization', `Bearer ${accessToken}`);
}

describe('POST /account/changePassword', () => {
  afterAll(async () => {
    for (const id of createdMemberIds) {
      await prisma.refreshToken.deleteMany({ where: { memberId: id } });
      await prisma.member.deleteMany({ where: { id } });
    }
    await prisma.$disconnect();
  });

  it("keeps the caller's own session alive and revokes the other devices", async () => {
    const oldPassword = 'secret123';
    const { email, id } = await makeMember(oldPassword);

    const deviceB = await loginOk(email, oldPassword);
    const deviceA = await loginOk(email, oldPassword);

    const res = await changePassword(deviceA.access_token, {
      oldPassword,
      newPassword: 'newSecret456',
      confirmNewPassword: 'newSecret456',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The caller proved knowledge of the old password → its session is trusted.
    expect((await profileInfo(deviceA.access_token)).status).toBe(200);
    // Every other device is evicted.
    expect((await profileInfo(deviceB.access_token)).status).toBe(401);

    const live = await prisma.refreshToken.count({
      where: { memberId: id, revokedAt: null },
    });
    expect(live).toBe(1);
  });

  it("the caller's refresh token still rotates after the change", async () => {
    const oldPassword = 'secret123';
    const { email } = await makeMember(oldPassword);
    const deviceA = await loginOk(email, oldPassword);

    expect(
      (
        await changePassword(deviceA.access_token, {
          oldPassword,
          newPassword: 'newSecret456',
          confirmNewPassword: 'newSecret456',
        })
      ).status,
    ).toBe(200);

    const rotated = await request(app)
      .post('/api/member/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: deviceA.refresh_token });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.access_token).toBeTruthy();
  });

  it('retires the old password and accepts the new one', async () => {
    const oldPassword = 'secret123';
    const newPassword = 'newSecret456';
    const { email } = await makeMember(oldPassword);
    const deviceA = await loginOk(email, oldPassword);

    expect(
      (
        await changePassword(deviceA.access_token, {
          oldPassword,
          newPassword,
          confirmNewPassword: newPassword,
        })
      ).status,
    ).toBe(200);

    expect((await login(email, oldPassword)).status).toBe(401);
    expect((await login(email, newPassword)).status).toBe(200);
  });

  it('rejects a wrong old password with PASSWORD_INCORRECT', async () => {
    const { email } = await makeMember('secret123');
    const deviceA = await loginOk(email, 'secret123');

    const res = await changePassword(deviceA.access_token, {
      oldPassword: 'notMyPassword',
      newPassword: 'newSecret456',
      confirmNewPassword: 'newSecret456',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_INCORRECT');
  });

  it('rejects a mismatched confirmation with PASSWORD_CONFIRMATION_MISMATCH', async () => {
    const { email } = await makeMember('secret123');
    const deviceA = await loginOk(email, 'secret123');

    const res = await changePassword(deviceA.access_token, {
      oldPassword: 'secret123',
      newPassword: 'newSecret456',
      confirmNewPassword: 'newSecret999',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_CONFIRMATION_MISMATCH');
  });

  it('rejects reusing the old password with PASSWORD_MUST_DIFFER', async () => {
    const { email } = await makeMember('secret123');
    const deviceA = await loginOk(email, 'secret123');

    const res = await changePassword(deviceA.access_token, {
      oldPassword: 'secret123',
      newPassword: 'secret123',
      confirmNewPassword: 'secret123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_MUST_DIFFER');
  });

  it('requires auth', async () => {
    const res = await request(app).post('/api/member/account/changePassword').send({
      oldPassword: 'secret123',
      newPassword: 'newSecret456',
      confirmNewPassword: 'newSecret456',
    });
    expect(res.status).toBe(401);
  });
});
