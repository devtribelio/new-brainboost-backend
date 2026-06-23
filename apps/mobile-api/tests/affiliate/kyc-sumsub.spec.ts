/**
 * Sumsub KYC flow: SDK session creation (service level, Sumsub API mocked) and
 * the /api/webhook/sumsub endpoint (HTTP level, real HMAC digest).
 *
 * Member-scoped only — seeds its own members. NO real Sumsub call is made.
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

// Mock the Sumsub client BEFORE the service imports it.
const { createApplicantMock, accessTokenMock, getByExternalIdMock } = vi.hoisted(() => ({
  createApplicantMock: vi.fn(),
  accessTokenMock: vi.fn(),
  getByExternalIdMock: vi.fn(),
}));
vi.mock('@bb/common/services/sumsub.client', () => ({
  isSumsubConfigured: () => true,
  createApplicant: createApplicantMock,
  generateSdkAccessToken: accessTokenMock,
  getApplicantByExternalId: getByExternalIdMock,
}));

import { prisma } from '@bb/db';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { buildApp } from '../../src/app';

const TAG = `kycsumsub-${Date.now()}`;
const svc = new DisbursementService();
const app = buildApp();
const WEBHOOK_SECRET = process.env.SUMSUB_WEBHOOK_SECRET!;

const createdMembers: string[] = [];
async function makeMember(kyc = 'NONE', sumsubApplicantId?: string): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `${TAG}-${randomUUID()}@kyc.local`,
      passwordHash: await bcrypt.hash('x', 4),
      kycStatus: kyc,
      ...(sumsubApplicantId ? { sumsubApplicantId } : {}),
    },
  });
  createdMembers.push(m.id);
  return m.id;
}

function postWebhook(payload: Record<string, unknown>, opts?: { badDigest?: boolean; alg?: string }) {
  const raw = JSON.stringify(payload);
  const alg = opts?.alg ?? 'HMAC_SHA256_HEX';
  const digest = opts?.badDigest
    ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    : createHmac(alg === 'HMAC_SHA512_HEX' ? 'sha512' : 'sha256', WEBHOOK_SECRET)
        .update(raw)
        .digest('hex');
  return request(app)
    .post('/api/webhook/sumsub')
    .set('Content-Type', 'application/json')
    .set('x-payload-digest', digest)
    .set('x-payload-digest-alg', alg)
    .send(raw);
}

afterAll(async () => {
  await prisma.member.deleteMany({ where: { id: { in: createdMembers } } });
});

describe('DisbursementService.createSumsubKycSession', () => {
  it('creates an applicant once, stores the id, and returns an SDK token', async () => {
    const memberId = await makeMember('NONE');
    createApplicantMock.mockResolvedValueOnce({ id: `app-${memberId}`, externalUserId: memberId });
    accessTokenMock.mockResolvedValue({ token: 'sdk-token-1', userId: memberId });

    const session = await svc.createSumsubKycSession(memberId);
    expect(session).toMatchObject({ token: 'sdk-token-1', applicantId: `app-${memberId}` });
    expect(createApplicantMock).toHaveBeenCalledWith(memberId);

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { sumsubApplicantId: true },
    });
    expect(row?.sumsubApplicantId).toBe(`app-${memberId}`);

    // Second session: applicant already stored → no second createApplicant call.
    createApplicantMock.mockClear();
    await svc.createSumsubKycSession(memberId);
    expect(createApplicantMock).not.toHaveBeenCalled();
  });

  it('resolves an existing applicant on 409 instead of failing', async () => {
    const memberId = await makeMember('NONE');
    const conflict = Object.assign(new Error('duplicate'), { status: 409 });
    createApplicantMock.mockRejectedValueOnce(conflict);
    getByExternalIdMock.mockResolvedValueOnce({ id: `app409-${memberId}`, externalUserId: memberId });
    accessTokenMock.mockResolvedValue({ token: 'sdk-token-2', userId: memberId });

    const session = await svc.createSumsubKycSession(memberId);
    expect(session.applicantId).toBe(`app409-${memberId}`);
  });

  it('rejects when KYC is already APPROVED', async () => {
    const memberId = await makeMember('APPROVED');
    await expect(svc.createSumsubKycSession(memberId)).rejects.toThrow('KYC sudah disetujui');
  });
});

describe('POST /api/webhook/sumsub', () => {
  it('401s on an invalid digest', async () => {
    const res = await postWebhook({ type: 'applicantReviewed', applicantId: 'x' }, { badDigest: true });
    expect(res.status).toBe(401);
  });

  it('applicantPending flips kycStatus to PENDING', async () => {
    const memberId = await makeMember('NONE');
    const applicantId = `app-pending-${memberId}`;
    const res = await postWebhook({ type: 'applicantPending', applicantId, externalUserId: memberId });
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, sumsubApplicantId: true, kycSubmittedAt: true },
    });
    expect(row?.kycStatus).toBe('PENDING');
    expect(row?.sumsubApplicantId).toBe(applicantId);
    expect(row?.kycSubmittedAt).not.toBeNull();
  });

  it('applicantReviewed GREEN approves; replay is idempotent', async () => {
    const applicantId = `app-green-${randomUUID()}`;
    const memberId = await makeMember('PENDING', applicantId);
    const payload = {
      type: 'applicantReviewed',
      applicantId,
      externalUserId: memberId,
      reviewResult: { reviewAnswer: 'GREEN' },
    };

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: true, kycStatus: 'APPROVED' });

    const replay = await postWebhook(payload);
    expect(replay.status).toBe(200);

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, kycReviewedAt: true, kycRejectedReason: true },
    });
    expect(row?.kycStatus).toBe('APPROVED');
    expect(row?.kycRejectedReason).toBeNull();
  });

  it('applicantReviewed RED RETRY rejects with labels in the reason', async () => {
    const applicantId = `app-red-${randomUUID()}`;
    const memberId = await makeMember('PENDING', applicantId);

    const res = await postWebhook({
      type: 'applicantReviewed',
      applicantId,
      reviewResult: {
        reviewAnswer: 'RED',
        reviewRejectType: 'RETRY',
        rejectLabels: ['BAD_PROOF_OF_IDENTITY', 'BLURRED_DOCUMENT'],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: true, kycStatus: 'REJECTED' });

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, kycRejectedReason: true },
    });
    expect(row?.kycStatus).toBe('REJECTED');
    expect(row?.kycRejectedReason).toBe('RETRY: BAD_PROOF_OF_IDENTITY, BLURRED_DOCUMENT');
  });

  it('acks unknown applicants and ignored event types with 200', async () => {
    const unknown = await postWebhook({
      type: 'applicantReviewed',
      applicantId: `app-ghost-${randomUUID()}`,
      reviewResult: { reviewAnswer: 'GREEN' },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.handled).toBe(false);

    const ignored = await postWebhook({ type: 'applicantCreated', applicantId: 'whatever' });
    expect(ignored.status).toBe(200);
    expect(ignored.body.handled).toBe(false);
  });

  it('accepts an HMAC_SHA512_HEX digest', async () => {
    const res = await postWebhook(
      { type: 'applicantCreated', applicantId: 'alg-test' },
      { alg: 'HMAC_SHA512_HEX' },
    );
    expect(res.status).toBe(200);
  });
});
