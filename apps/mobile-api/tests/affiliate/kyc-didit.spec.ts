/**
 * Didit KYC flow: verification session creation (service level, Didit API mocked)
 * and the /api/webhook/didit endpoint (HTTP level, real HMAC-SHA256 + timestamp).
 *
 * Member-scoped only — seeds its own members. NO real Didit call is made.
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

// Mock the Didit client BEFORE the service imports it.
const { createSessionMock } = vi.hoisted(() => ({ createSessionMock: vi.fn() }));
vi.mock('@bb/common/services/didit.client', () => ({
  isDiditConfigured: () => true,
  createSession: createSessionMock,
}));

import { prisma } from '@bb/db';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { buildApp } from '../../src/app';

const TAG = `kycdidit-${Date.now()}`;
const svc = new DisbursementService();
const app = buildApp();
const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET!;

const createdMembers: string[] = [];
async function makeMember(kyc = 'NONE', kycProviderRef?: string): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `${TAG}-${randomUUID()}@kyc.local`,
      passwordHash: await bcrypt.hash('x', 4),
      kycStatus: kyc,
      ...(kycProviderRef ? { kycProviderRef } : {}),
    },
  });
  createdMembers.push(m.id);
  return m.id;
}

function postWebhook(payload: Record<string, unknown>, opts?: { badSignature?: boolean }) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = opts?.badSignature
    ? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    : createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return request(app)
    .post('/api/webhook/didit')
    .set('Content-Type', 'application/json')
    .set('x-signature', signature)
    .set('x-timestamp', timestamp)
    .send(raw);
}

afterAll(async () => {
  await prisma.member.deleteMany({ where: { id: { in: createdMembers } } });
});

describe('DisbursementService.createDiditSession', () => {
  it('mints a session and stores its id as the active kycProviderRef', async () => {
    const memberId = await makeMember('NONE');
    createSessionMock.mockResolvedValueOnce({
      session_id: `sess-${memberId}`,
      session_token: 'tok-123',
      url: 'https://verify.didit.me/s/tok-123',
      status: 'Not Started',
    });

    const session = await svc.createDiditSession(memberId);
    expect(session).toMatchObject({
      sessionId: `sess-${memberId}`,
      sessionToken: 'tok-123',
      url: 'https://verify.didit.me/s/tok-123',
    });
    expect(createSessionMock).toHaveBeenCalledWith(memberId);

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycProviderRef: true },
    });
    expect(row?.kycProviderRef).toBe(`sess-${memberId}`);
  });

  it('rejects when KYC is already APPROVED', async () => {
    const memberId = await makeMember('APPROVED');
    await expect(svc.createDiditSession(memberId)).rejects.toThrow('KYC sudah disetujui');
  });
});

describe('POST /api/webhook/didit', () => {
  it('401s on an invalid signature', async () => {
    const res = await postWebhook({ status: 'Approved', session_id: 'x' }, { badSignature: true });
    expect(res.status).toBe(401);
  });

  it('"In Review" flips kycStatus to PENDING', async () => {
    const sessionId = `sess-pending-${randomUUID()}`;
    const memberId = await makeMember('NONE', sessionId);
    const res = await postWebhook({ status: 'In Review', session_id: sessionId, vendor_data: memberId });
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, kycSource: true, kycSubmittedAt: true },
    });
    expect(row?.kycStatus).toBe('PENDING');
    expect(row?.kycSource).toBe('DIDIT');
    expect(row?.kycSubmittedAt).not.toBeNull();
  });

  it('"Approved" approves the member; replay is idempotent', async () => {
    const sessionId = `sess-green-${randomUUID()}`;
    const memberId = await makeMember('PENDING', sessionId);
    const payload = { status: 'Approved', session_id: sessionId, vendor_data: memberId };

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: true, kycStatus: 'APPROVED' });

    const replay = await postWebhook(payload);
    expect(replay.status).toBe(200);

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, kycRejectedReason: true },
    });
    expect(row?.kycStatus).toBe('APPROVED');
    expect(row?.kycRejectedReason).toBeNull();

    // Exactly one APPROVE audit row despite the replay.
    const events = await prisma.kycEvent.count({ where: { memberId, type: 'APPROVE' } });
    expect(events).toBe(1);
  });

  it('"Declined" rejects with the decision reason', async () => {
    const sessionId = `sess-red-${randomUUID()}`;
    const memberId = await makeMember('PENDING', sessionId);

    const res = await postWebhook({
      status: 'Declined',
      session_id: sessionId,
      vendor_data: memberId,
      decision: { reason: 'BLURRED_DOCUMENT' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: true, kycStatus: 'REJECTED' });

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true, kycRejectedReason: true },
    });
    expect(row?.kycStatus).toBe('REJECTED');
    expect(row?.kycRejectedReason).toBe('BLURRED_DOCUMENT');
  });

  it('IGNORES a stale "Approved" from a superseded session (re-KYC guard)', async () => {
    // Member is EXPIRED with a fresh active session; an old session's webhook must
    // NOT re-approve them.
    const memberId = await makeMember('EXPIRED', `sess-active-${randomUUID()}`);
    const res = await postWebhook({
      status: 'Approved',
      session_id: `sess-OLD-${randomUUID()}`,
      vendor_data: memberId,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handled: false, reason: 'stale session' });

    const row = await prisma.member.findUnique({
      where: { id: memberId },
      select: { kycStatus: true },
    });
    expect(row?.kycStatus).toBe('EXPIRED');
  });

  it('acks unknown sessions and ignored statuses with 200', async () => {
    const unknown = await postWebhook({
      status: 'Approved',
      session_id: `sess-ghost-${randomUUID()}`,
      vendor_data: randomUUID(),
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.handled).toBe(false);

    const ignored = await postWebhook({ status: 'Not Started', session_id: 'whatever' });
    expect(ignored.status).toBe(200);
    expect(ignored.body.handled).toBe(false);
  });
});
