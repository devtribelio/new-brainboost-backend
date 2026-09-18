import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { prisma } from '@bb/db';
import { purgeScheduledDeletions } from '@bb/domain/jobs/purge-scheduled-deletions';
import { buildApp } from '../src/app';

const app = buildApp();
const PASSWORD = 'secret123';
const createdEmails: string[] = [];

// The delete-account flow is OTP-gated. Rather than reach into `otp_codes` (the
// code is bcrypt-hashed, so it cannot be read back), drive it through the fixed
// tester code the app already supports for store review — that is the only way to
// exercise requestDeleteAccount → verificationDeleteAccount as a real client does.
// testAccountConfig() reads process.env live, and vitest runs --no-file-parallelism,
// so mutating it here is safe.
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function uniqueEmail(tag: string): string {
  return `softdel-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

async function makeMember(tag: string) {
  const email = uniqueEmail(tag);
  createdEmails.push(email);
  await request(app)
    .post('/api/member/auth/register')
    .send({ email, password: PASSWORD, fullName: 'SoftDelete Tester' });
  await prisma.member.update({
    where: { email },
    data: { isActive: true, isEmailVerified: true },
  });
  const member = await prisma.member.findUniqueOrThrow({ where: { email } });
  return { email, id: member.id };
}

async function login(email: string) {
  return request(app)
    .post('/api/member/oauth/token')
    .send({ grant_type: 'password', username: email, password: PASSWORD, client_type: 'web' });
}

async function loginOk(email: string) {
  const res = await login(email);
  expect(res.status).toBe(200);
  return res.body.data as { access_token: string };
}

/** Run the real two-step deletion request as the mobile client does. */
async function scheduleDeletion(email: string, accessToken: string) {
  setEnv('TEST_ACCOUNT_IDENTIFIERS', email);
  const requested = await request(app)
    .post('/api/member/account/requestDeleteAccount')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ agree: true });
  expect(requested.status).toBe(200);

  const verified = await request(app)
    .post('/api/member/account/verificationDeleteAccount')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ otpCode: '000000' });
  expect(verified.status).toBe(200);
}

/** Move an already-scheduled deadline into the past so the purge picks the row up. */
async function expireDeadline(memberId: string) {
  await prisma.member.update({
    where: { id: memberId },
    data: { scheduledDeletionAt: new Date(Date.now() - 60_000) },
  });
}

beforeAll(() => {
  setEnv('TEST_ACCOUNT_ENABLED', 'true');
  setEnv('TEST_ACCOUNT_OTP_CODE', '000000');
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const ids = (
    await prisma.member.findMany({
      where: { OR: [{ email: { in: createdEmails } }, { email: { contains: 'softdel-' } }] },
      select: { id: true },
    })
  ).map((m) => m.id);
  if (ids.length === 0) return;
  await prisma.refreshToken.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.networkMember.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.memberProfile.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.member.deleteMany({ where: { id: { in: ids } } });
});

describe('account deletion — scheduling and the grace window', () => {
  it('schedules a deadline, deactivates, and revokes every live session', async () => {
    const { email, id } = await makeMember('sched');
    const { access_token } = await loginOk(email);

    await scheduleDeletion(email, access_token);

    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    expect(member.scheduledDeletionAt).toBeInstanceOf(Date);
    expect(member.scheduledDeletionAt!.getTime()).toBeGreaterThan(Date.now());
    expect(member.isActive).toBe(false);
    expect(member.deletedAt).toBeNull();

    // The access token the caller still holds must stop working immediately — its
    // refresh row was revoked without a successor, so no rotation grace applies.
    const afterward = await request(app)
      .get('/api/member/account/profile/info')
      .set('Authorization', `Bearer ${access_token}`);
    expect(afterward.status).toBe(401);
  });

  it('lets the owner log back in during the window WITHOUT cancelling the deletion', async () => {
    const { email, id } = await makeMember('reopen');
    const first = await loginOk(email);
    await scheduleDeletion(email, first.access_token);

    // This is the fix: before it, every login path rejected the inactive row and
    // recoverAccountScheduled (which needs authGuard) could never be reached.
    const again = await loginOk(email);

    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    expect(member.isActive).toBe(true);
    // Logging in is not consent to cancel — the deadline must survive, so the
    // banner still has something to offer and silence still deletes.
    expect(member.scheduledDeletionAt).not.toBeNull();

    const profile = await request(app)
      .get('/api/member/account/profile/info')
      .set('Authorization', `Bearer ${again.access_token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.isDeleted).toBe(1);
    expect(profile.body.data.scheduledDeletionAt).toBe(
      member.scheduledDeletionAt!.toISOString(),
    );
  });

  it('cancels only on the explicit recover call', async () => {
    const { email, id } = await makeMember('recover');
    const first = await loginOk(email);
    await scheduleDeletion(email, first.access_token);
    const again = await loginOk(email);

    const res = await request(app)
      .post('/api/member/account/recoverAccountScheduled')
      .set('Authorization', `Bearer ${again.access_token}`)
      .send({});
    expect(res.status).toBe(200);

    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    expect(member.scheduledDeletionAt).toBeNull();
    expect(member.isActive).toBe(true);
  });

  it('refuses login and recovery once the deadline has passed', async () => {
    const { email, id } = await makeMember('expired');
    const first = await loginOk(email);
    await scheduleDeletion(email, first.access_token);
    await expireDeadline(id);

    const res = await login(email);
    expect(res.status).toBe(401);
    // Gated on the deadline, not on deletedAt: the purge runs hourly, so the answer
    // must not depend on whether it happens to have run yet.
    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    expect(member.isActive).toBe(false);
    expect(member.deletedAt).toBeNull();
  });
});

describe('purgeScheduledDeletions', () => {
  it('anonymises the row, keeps it, and frees the email for someone else', async () => {
    const { email, id } = await makeMember('purge');
    const { access_token } = await loginOk(email);
    await prisma.member.update({
      where: { id },
      data: { phone: `62811${Date.now() % 1_000_000}`, bankAccountNumber: '1234567890' },
    });
    await scheduleDeletion(email, access_token);
    await expireDeadline(id);

    const result = await purgeScheduledDeletions();
    expect(result.purged).toBeGreaterThanOrEqual(1);

    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    // The row survives: every FK, the inviter chain and the financial history hang
    // off it, and four of those FKs are ON DELETE RESTRICT.
    expect(member.deletedAt).toBeInstanceOf(Date);
    expect(member.email).toMatch(new RegExp(`^del:${id}:`));
    expect(member.email).not.toContain(email);
    expect(member.phone).toMatch(new RegExp(`^del:${id}:`));
    expect(member.fullName).toBeNull();
    expect(member.bankAccountNumber).toBeNull();
    expect(member.passwordAlgo).toBe('deleted');
    expect(member.isActive).toBe(false);

    // The whole point of rewriting rather than keeping the value: the address is
    // free again, so its owner can open a new account with it.
    const reuse = await request(app)
      .post('/api/member/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Someone Else' });
    expect(reuse.status).toBeLessThan(400);
    const fresh = await prisma.member.findUniqueOrThrow({ where: { email } });
    expect(fresh.id).not.toBe(id);
  });

  it('leaves a member who cancelled in time completely alone', async () => {
    const { email, id } = await makeMember('raced');
    const first = await loginOk(email);
    await scheduleDeletion(email, first.access_token);
    const again = await loginOk(email);
    await request(app)
      .post('/api/member/account/recoverAccountScheduled')
      .set('Authorization', `Bearer ${again.access_token}`)
      .send({});

    await purgeScheduledDeletions();

    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    expect(member.deletedAt).toBeNull();
    expect(member.email).toBe(email);
    expect(member.isActive).toBe(true);
  });

  it('keeps commission on the books, cancels the pending payout, and revokes KYC', async () => {
    const { email, id } = await makeMember('void');
    const { access_token } = await loginOk(email);
    await prisma.member.update({ where: { id }, data: { kycStatus: 'APPROVED' } });

    const product = await prisma.product.create({
      data: { type: 'course', title: `softdel-void-${Date.now()}`, price: 1_000_000 },
    });
    await prisma.affiliateCommission.createMany({
      data: [
        { paymentId: randomUUID(), recipientId: id, level: 1, amount: 200_000, status: 'PENDING', affiliateBased: 'PERFORMANCE', commissionRate: 20 },
        { paymentId: randomUUID(), recipientId: id, level: 1, amount: 150_000, status: 'BALANCE', affiliateBased: 'PERFORMANCE', commissionRate: 20 },
      ],
    });
    const payout = await prisma.affiliateDisbursement.create({
      data: {
        memberId: id,
        grossAmount: 150_000,
        fee: 5_000,
        netAmount: 145_000,
        status: 'PENDING',
        // Snapshotted at request time — this is why clearing members.bank_* is not
        // enough on its own to stop the money.
        bankCode: 'BCA',
        bankAccountNumber: '1234567890',
        bankAccountName: 'SoftDelete Tester',
      },
    });

    await scheduleDeletion(email, access_token);
    await expireDeadline(id);
    await purgeScheduledDeletions();

    // The expense stays booked. Voiding would be a write-off in a later period than the
    // one it undoes, and would have to be reversed again if support reopens the account.
    const commissions = await prisma.affiliateCommission.findMany({
      where: { recipientId: id },
      select: { amount: true, status: true },
    });
    expect(commissions.map((c) => c.status).sort()).toEqual(['BALANCE', 'PENDING']);

    // The payout does die: the bank snapshot survives anonymisation and the sweeper
    // gates only on kycStatus, so this is the one outcome that cannot be undone.
    const after = await prisma.affiliateDisbursement.findUniqueOrThrow({
      where: { id: payout.id },
    });
    expect(after.status).toBe('VOIDED');
    const sweepable = await prisma.affiliateDisbursement.findMany({
      where: { status: 'PENDING', approvedAt: { not: null }, member: { deletedAt: null } },
    });
    expect(sweepable.find((d) => d.id === payout.id)).toBeUndefined();

    // The APPROVED stamp cannot outlive the documents that earned it — otherwise a
    // restored account walks straight through the payout gate with no KYC on file.
    const member = await prisma.member.findUniqueOrThrow({ where: { id } });
    expect(member.kycStatus).toBe('EXPIRED');
    expect(member.kycIdNumber).toBeNull();
    expect(member.isEmailVerified).toBe(false);
    expect(member.isPhoneVerified).toBe(false);

    const events = await prisma.kycEvent.findMany({ where: { memberId: id } });
    expect(events.some((e) => e.type === 'RESET' && e.reason === 'ACCOUNT_DELETED')).toBe(true);

    await prisma.kycEvent.deleteMany({ where: { memberId: id } });
    await prisma.affiliateDisbursement.deleteMany({ where: { memberId: id } });
    await prisma.affiliateCommission.deleteMany({ where: { recipientId: id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it('is idempotent — a second run does not re-anonymise an already purged row', async () => {
    const { email, id } = await makeMember('idem');
    const { access_token } = await loginOk(email);
    await scheduleDeletion(email, access_token);
    await expireDeadline(id);

    await purgeScheduledDeletions();
    const afterFirst = await prisma.member.findUniqueOrThrow({ where: { id } });
    await purgeScheduledDeletions();
    const afterSecond = await prisma.member.findUniqueOrThrow({ where: { id } });

    expect(afterSecond.email).toBe(afterFirst.email);
    expect(afterSecond.deletedAt!.getTime()).toBe(afterFirst.deletedAt!.getTime());
  });
});
