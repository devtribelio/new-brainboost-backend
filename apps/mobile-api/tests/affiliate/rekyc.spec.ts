/**
 * Re-KYC (KYC reset) triggers + gate. Member-scoped; seeds its own data.
 * Sumsub client is mocked so resetKyc's applicant-reset branch is observable
 * without a real API call. Requires a reachable Postgres test DB (DATABASE_URL).
 * See docs/kyc-rekyc.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

// Mock the Sumsub client BEFORE the service imports it. isSumsubConfigured=true so
// resetKyc attempts the applicant reset for members that have an applicant id.
const { resetApplicantMock } = vi.hoisted(() => ({ resetApplicantMock: vi.fn() }));
vi.mock('@bb/common/services/sumsub.client', () => ({
  isSumsubConfigured: () => true,
  resetApplicant: resetApplicantMock,
  createApplicant: vi.fn(),
  generateSdkAccessToken: vi.fn(),
  getApplicantByExternalId: vi.fn(),
}));

import { prisma } from '@bb/db';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { MemberService } from '../../src/modules/member/member.service';

const TAG = `rekyc-${Date.now()}`;
const svc = new DisbursementService();
const memberSvc = new MemberService();
const DAY_MS = 86_400_000;

const createdMembers: string[] = [];
async function makeMember(data: Record<string, unknown> = {}): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `${TAG}-${randomUUID()}@rekyc.local`,
      passwordHash: await bcrypt.hash('x', 4),
      kycStatus: 'APPROVED',
      ...data,
    },
  });
  createdMembers.push(m.id);
  return m.id;
}

async function latestEvent(memberId: string) {
  return prisma.kycEvent.findFirst({ where: { memberId }, orderBy: { createdAt: 'desc' } });
}

let programId = '';
let productId = '';

beforeAll(async () => {
  const product = await prisma.product.create({ data: { type: 'course', title: `${TAG}-p`, price: 0 } });
  productId = product.id;
  const program = await prisma.affiliateProgram.create({
    data: { code: `${TAG}-prog`, name: 'ReKyc Program', productId, isActive: true },
  });
  programId = program.id;
});

afterAll(async () => {
  await prisma.affiliateDisbursement.deleteMany({ where: { memberId: { in: createdMembers } } });
  await prisma.affiliateCommission.deleteMany({ where: { recipientId: { in: createdMembers } } });
  // kyc_event rows cascade on member delete.
  await prisma.member.deleteMany({ where: { id: { in: createdMembers } } });
  await prisma.affiliateProgram.delete({ where: { id: programId } });
  await prisma.product.delete({ where: { id: productId } });
});

describe('DisbursementService.resetKyc', () => {
  it('downgrades APPROVED → EXPIRED and records a RESET event', async () => {
    const id = await makeMember({ kycSource: 'SUMSUB' });
    const { reset } = await svc.resetKyc(id, 'ADMIN_MANUAL', { actorType: 'ADMIN' });
    expect(reset).toBe(true);

    const m = await prisma.member.findUnique({ where: { id } });
    expect(m?.kycStatus).toBe('EXPIRED');
    expect(m?.kycSource).toBe('SUMSUB'); // provenance preserved

    const ev = await latestEvent(id);
    expect(ev).toMatchObject({ type: 'RESET', reason: 'ADMIN_MANUAL', fromStatus: 'APPROVED', toStatus: 'EXPIRED', actorType: 'ADMIN' });
  });

  it('is a no-op when not APPROVED (no event written)', async () => {
    const id = await makeMember({ kycStatus: 'PENDING' });
    const { reset } = await svc.resetKyc(id, 'SUSPICIOUS');
    expect(reset).toBe(false);
    expect(await latestEvent(id)).toBeNull();
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('PENDING');
  });

  it('resets the Sumsub applicant when one is bound', async () => {
    resetApplicantMock.mockClear();
    const applicantId = `appl-${randomUUID()}`;
    const id = await makeMember({ sumsubApplicantId: applicantId });
    await svc.resetKyc(id, 'SUSPICIOUS');
    expect(resetApplicantMock).toHaveBeenCalledWith(applicantId);
  });

  it('does not call Sumsub for a legacy member with no applicant', async () => {
    resetApplicantMock.mockClear();
    const id = await makeMember({ kycSource: 'LEGACY' });
    await svc.resetKyc(id, 'SUSPICIOUS');
    expect(resetApplicantMock).not.toHaveBeenCalled();
  });
});

describe('setBankAccount re-KYC trigger', () => {
  const bank = { bankCode: 'BCA', bankAccountNumber: '1111111111', bankAccountName: 'A' };

  it('resets KYC when an existing account is changed', async () => {
    const id = await makeMember(bank);
    await svc.setBankAccount(id, { ...bank, bankAccountNumber: '2222222222' });
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('EXPIRED');
    expect((await latestEvent(id))?.reason).toBe('BANK_CHANGE');
  });

  it('does NOT reset on first-time account setup', async () => {
    const id = await makeMember(); // no bank yet
    await svc.setBankAccount(id, bank);
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('APPROVED');
    expect(await latestEvent(id)).toBeNull();
  });

  it('does NOT reset when the same account is re-submitted', async () => {
    const id = await makeMember(bank);
    await svc.setBankAccount(id, bank);
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('APPROVED');
  });
});

describe('requestDisbursement gate + large-disbursement trigger', () => {
  async function seedBalance(memberId: string, amount: number) {
    await prisma.affiliateCommission.create({
      data: {
        recipientId: memberId, programId, productId, paymentId: randomUUID(), level: 1,
        affiliateBased: 'PERFORMANCE', productPrice: amount, voucherAmount: 0,
        commissionRate: 20, amount, status: 'BALANCE',
      },
    });
  }
  const bank = { bankCode: 'BCA', bankAccountNumber: '3333333333', bankAccountName: 'B' };

  it('rejects an EXPIRED member with the re-KYC message', async () => {
    const id = await makeMember({ kycStatus: 'EXPIRED', ...bank });
    await expect(svc.requestDisbursement(id)).rejects.toThrow('KYC perlu diperbarui');
  });

  it('forces re-KYC on a large disbursement when the last review is stale', async () => {
    const stale = new Date(Date.now() - 200 * DAY_MS);
    const id = await makeMember({ ...bank, kycReviewedAt: stale });
    await seedBalance(id, 6_000_000);
    await expect(svc.requestDisbursement(id)).rejects.toThrow('verifikasi KYC ulang');
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('EXPIRED');
    expect((await latestEvent(id))?.reason).toBe('LARGE_DISBURSEMENT');
    // aborted tx → no disbursement row created
    expect(await prisma.affiliateDisbursement.count({ where: { memberId: id } })).toBe(0);
  });

  it('allows a large disbursement when the review is fresh', async () => {
    const id = await makeMember({ ...bank, kycReviewedAt: new Date() });
    await seedBalance(id, 6_000_000);
    const row = await svc.requestDisbursement(id);
    expect(row).toBeTruthy();
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('APPROVED');
  });
});

describe('dormant reactivation re-KYC trigger (MemberService.findById)', () => {
  it('resets KYC when the member returns after the dormancy window', async () => {
    const id = await makeMember({
      isActive: true,
      lastActiveAt: new Date(Date.now() - 400 * DAY_MS),
    });
    await memberSvc.findById(id, { touchActivity: true });
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('EXPIRED');
    expect((await latestEvent(id))?.reason).toBe('DORMANT_REACTIVATION');
  });

  it('does NOT reset an active member', async () => {
    const id = await makeMember({
      isActive: true,
      lastActiveAt: new Date(Date.now() - 5 * DAY_MS),
    });
    await memberSvc.findById(id, { touchActivity: true });
    expect((await prisma.member.findUnique({ where: { id } }))?.kycStatus).toBe('APPROVED');
  });
});
