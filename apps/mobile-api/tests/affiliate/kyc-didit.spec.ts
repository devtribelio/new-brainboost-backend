/**
 * Didit KYC flow: verification session creation (service level, Didit API mocked)
 * and the /api/webhook/didit endpoint (HTTP level, real HMAC-SHA256 + timestamp).
 *
 * Member-scoped only — seeds its own members. NO real Didit call is made.
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import {
  settingsService,
  SettingsService,
  SETTING_KEYS,
} from '@bb/common/services/settings.service';

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

describe('DisbursementService KYC min-balance gate (app_settings kyc.minBalance)', () => {
  let programId = '';
  let productId = '';
  const gateMembers: string[] = [];
  const MIN = '55000';

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: { type: 'course', title: `${TAG}-bal`, price: 0 },
    });
    productId = product.id;
    const program = await prisma.affiliateProgram.create({
      data: { code: `${TAG}-balprog`, name: 'Bal Gate', productId, isActive: true },
    });
    programId = program.id;
  });

  afterAll(async () => {
    await prisma.affiliateCommission.deleteMany({ where: { recipientId: { in: gateMembers } } });
    await prisma.member.deleteMany({ where: { id: { in: gateMembers } } });
    await prisma.affiliateProgram.delete({ where: { id: programId } });
    await prisma.product.delete({ where: { id: productId } });
    // Restore "row absent → fallback 0 (gate off)" so other specs are unaffected.
    await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.kycMinBalance } });
    SettingsService.clearCache();
  });

  async function makeGateMember(): Promise<string> {
    const m = await prisma.member.create({
      data: {
        email: `${TAG}-gate-${randomUUID()}@kyc.local`,
        passwordHash: await bcrypt.hash('x', 4),
        kycStatus: 'NONE',
      },
    });
    gateMembers.push(m.id);
    return m.id;
  }

  async function seedBalance(memberId: string, amount: number) {
    await prisma.affiliateCommission.create({
      data: {
        recipientId: memberId,
        programId,
        productId,
        paymentId: randomUUID(),
        level: 1,
        affiliateBased: 'PERFORMANCE',
        productPrice: amount,
        voucherAmount: 0,
        commissionRate: 20,
        amount,
        status: 'BALANCE',
      },
    });
  }

  async function setGate(value: string) {
    await settingsService.set(SETTING_KEYS.kycMinBalance, value);
    SettingsService.clearCache();
  }

  it('blocks createDiditSession when withdrawable balance is below the minimum', async () => {
    await setGate(MIN);
    const id = await makeGateMember();
    await seedBalance(id, 50_000); // < 55000
    createSessionMock.mockClear();
    await expect(svc.createDiditSession(id)).rejects.toThrow(
      'Saldo belum mencukupi untuk verifikasi KYC',
    );
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('allows createDiditSession when balance meets the minimum (boundary inclusive)', async () => {
    await setGate(MIN);
    const id = await makeGateMember();
    await seedBalance(id, 55_000); // == 55000
    createSessionMock.mockResolvedValueOnce({
      session_id: `sess-bal-${id}`,
      session_token: 'tok',
      url: 'https://verify.example/s/tok',
      status: 'Not Started',
    });
    const res = await svc.createDiditSession(id);
    expect(res.sessionId).toBe(`sess-bal-${id}`);
  });

  it('blocks manual submitKyc too (no bypass via the manual path)', async () => {
    await setGate(MIN);
    const id = await makeGateMember();
    await seedBalance(id, 10_000);
    await expect(
      svc.submitKyc(id, { idNumber: '3201010101010001', idCardUrl: 'https://x/ktp.webp' }),
    ).rejects.toThrow('Saldo belum mencukupi untuk verifikasi KYC');
  });

  it('gate is OFF when kyc.minBalance = 0 — nil-balance member can start KYC', async () => {
    await setGate('0');
    const id = await makeGateMember(); // zero balance
    createSessionMock.mockResolvedValueOnce({
      session_id: `sess-off-${id}`,
      session_token: 'tok',
      url: 'https://verify.example/s/tok',
      status: 'Not Started',
    });
    const res = await svc.createDiditSession(id);
    expect(res.sessionId).toBe(`sess-off-${id}`);
  });

  it('getKyc returns kycMinBalance + isEligible=false when balance is below the minimum', async () => {
    await setGate(MIN);
    const id = await makeGateMember();
    await seedBalance(id, 50_000); // < 55000
    const kyc = await svc.getKyc(id);
    expect(kyc.kycMinBalance).toBe(55_000);
    expect(kyc.isEligible).toBe(false);
  });

  it('getKyc returns isEligible=true when balance meets the minimum and not approved', async () => {
    await setGate(MIN);
    const id = await makeGateMember();
    await seedBalance(id, 60_000); // >= 55000
    const kyc = await svc.getKyc(id);
    expect(kyc.kycMinBalance).toBe(55_000);
    expect(kyc.isEligible).toBe(true);
  });
});
