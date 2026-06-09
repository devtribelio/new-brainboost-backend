/**
 * Affiliate disbursement end-to-end flow (REAL MONEY logic).
 *
 * Member-scoped only (safe on shared/staging DB): seeds its own member +
 * BALANCE commissions, never runs global jobs. The Xendit client is MOCKED —
 * NO real disbursement is ever created.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

// Mock the Xendit disbursement client BEFORE the service imports it.
const { createDisbursementMock } = vi.hoisted(() => ({ createDisbursementMock: vi.fn() }));
vi.mock('@bb/common/services/xendit.client', () => ({
  createDisbursement: createDisbursementMock,
}));

import { prisma } from '@bb/db';
import { DisbursementService } from '@bb/domain/affiliate/disbursement.service';
import { SettingsService } from '@bb/common/services/settings.service';

const TAG = `disbflow-${Date.now()}`;
const svc = new DisbursementService();

let programId = '';
let productId = '';

const PRIOR_PAID_GROSS = 10_000;
async function makeMember(opts: {
  kyc?: string;
  bank?: boolean;
  balance: number;
  priorPaid?: boolean;
}): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `${TAG}-${randomUUID()}@disb.local`,
      passwordHash: await bcrypt.hash('x', 4),
      kycStatus: opts.kyc ?? 'APPROVED',
      ...(opts.bank !== false
        ? { bankCode: 'BCA', bankAccountNumber: '1234567890', bankAccountName: 'TEST USER' }
        : {}),
    },
  });
  // Commission covers the requested withdrawable PLUS any prior payout's gross, so
  // getWithdrawableBalance() == opts.balance after the prior PAID is subtracted.
  const commission = opts.balance + (opts.priorPaid ? PRIOR_PAID_GROSS : 0);
  if (commission > 0) {
    await prisma.affiliateCommission.create({
      data: {
        recipientId: m.id,
        programId,
        productId,
        paymentId: randomUUID(),
        level: 1,
        affiliateBased: 'PERFORMANCE',
        productPrice: commission,
        voucherAmount: 0,
        commissionRate: 20,
        amount: commission,
        status: 'BALANCE',
      },
    });
  }
  if (opts.priorPaid) {
    // Past-dated (last week) so it satisfies the not-first-time AUTO gate WITHOUT
    // counting toward the today / this-week velocity limits.
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await prisma.affiliateDisbursement.create({
      data: {
        memberId: m.id,
        grossAmount: PRIOR_PAID_GROSS,
        fee: 5_000,
        netAmount: PRIOR_PAID_GROSS - 5_000,
        status: 'PAID',
        mode: 'MANUAL',
        externalId: `prior-${randomUUID()}`,
        requestedAt: past,
        paidAt: past,
      },
    });
  }
  return m.id;
}

const createdMembers: string[] = [];
async function member(opts: { kyc?: string; bank?: boolean; balance: number; priorPaid?: boolean }) {
  const id = await makeMember(opts);
  createdMembers.push(id);
  return id;
}

describe('DisbursementService — payout flow', () => {
  beforeAll(async () => {
    const product = await prisma.product.create({ data: { type: 'course', title: `${TAG}-p`, price: 0 } });
    productId = product.id;
    const program = await prisma.affiliateProgram.create({
      data: { code: `${TAG}-prog`, name: 'Disb Flow Program', productId, isActive: true },
    });
    programId = program.id;
  });

  afterAll(async () => {
    for (const id of createdMembers) {
      await prisma.affiliateDisbursement.deleteMany({ where: { memberId: id } });
      await prisma.affiliateCommission.deleteMany({ where: { recipientId: id } });
      await prisma.member.delete({ where: { id } }).catch(() => {});
    }
    await prisma.affiliateProgram.delete({ where: { id: programId } }).catch(() => {});
    await prisma.product.delete({ where: { id: productId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(() => {
    createDisbursementMock.mockReset();
    createDisbursementMock.mockResolvedValue({ id: 'xendit-disb-1', status: 'PENDING', raw: {} });
    SettingsService.clearCache();
  });

  afterEach(() => {
    SettingsService.clearCache();
  });

  // ---- gates --------------------------------------------------------------

  it('rejects when KYC is not APPROVED', async () => {
    const id = await member({ kyc: 'PENDING', balance: 100_000 });
    await expect(svc.requestDisbursement(id)).rejects.toThrow(/KYC belum disetujui/i);
    expect(createDisbursementMock).not.toHaveBeenCalled();
  });

  it('rejects when bank account is missing', async () => {
    const id = await member({ kyc: 'APPROVED', bank: false, balance: 100_000 });
    await expect(svc.requestDisbursement(id)).rejects.toThrow(/Rekening belum diisi/i);
    expect(createDisbursementMock).not.toHaveBeenCalled();
  });

  // ---- auto vs manual decision -------------------------------------------

  it('first-time withdrawal is MANUAL (no prior PAID) — does not call Xendit', async () => {
    const id = await member({ balance: 100_000 });
    const row = await svc.requestDisbursement(id);
    expect(row.mode).toBe('MANUAL');
    expect(row.status).toBe('PENDING');
    expect(createDisbursementMock).not.toHaveBeenCalled();
  });

  it('repeat + small amount → AUTO (fires Xendit, status PROCESSING)', async () => {
    const id = await member({ balance: 50_000, priorPaid: true });
    const row = await svc.requestDisbursement(id);
    expect(row.mode).toBe('AUTO');
    expect(row.status).toBe('PROCESSING');
    expect(row.providerRef).toBe('xendit-disb-1');
    expect(createDisbursementMock).toHaveBeenCalledTimes(1);
    const arg = createDisbursementMock.mock.calls[0][0];
    expect(arg.amount).toBe(45_000); // net = 50,000 - 5,000 fee
    expect(arg.bankCode).toBe('BCA');
    expect(arg.externalId).toMatch(/^disb-/);
  });

  it('over the auto cap → MANUAL', async () => {
    const id = await member({ balance: 2_000_000, priorPaid: true });
    // net = 1,995,000 > default cap 1,000,000 → MANUAL
    const row = await svc.requestDisbursement(id);
    expect(row.mode).toBe('MANUAL');
    expect(createDisbursementMock).not.toHaveBeenCalled();
  });

  it('more than 1 payout today → MANUAL (velocity day limit)', async () => {
    const id = await member({ balance: 50_000 });
    const now = new Date();
    // A PAID payout earlier today means todayCount = 1 (> MAX_PER_DAY-1 = 0) → MANUAL.
    // It also satisfies the prior-PAID gate, so the only reason left is velocity.
    await prisma.affiliateDisbursement.create({
      data: { memberId: id, grossAmount: 10_000, fee: 5_000, netAmount: 5_000, status: 'PAID', mode: 'AUTO', externalId: `todaypaid-${randomUUID()}`, requestedAt: now, paidAt: now },
    });
    const row = await svc.requestDisbursement(id);
    expect(row.mode).toBe('MANUAL'); // todayCount (PAID today) > 0 → MANUAL
    expect(createDisbursementMock).not.toHaveBeenCalled();
  });

  it('more than 3 payouts this week → MANUAL (velocity week limit)', async () => {
    const id = await member({ balance: 100_000 });
    const now = new Date();
    // Anchor to the start of THIS week (Monday 00:00) + 1h so all rows fall inside
    // the week window. weekCount = 4 > 3 → MANUAL. (Day count may also trip on
    // Mondays; both paths converge to MANUAL, which is what we assert.)
    const day = now.getDay();
    const diff = (day + 6) % 7;
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 1, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      await prisma.affiliateDisbursement.create({
        data: { memberId: id, grossAmount: 10_000, fee: 5_000, netAmount: 5_000, status: 'PAID', mode: 'AUTO', externalId: `wk-${randomUUID()}`, requestedAt: weekStart, paidAt: weekStart },
      });
    }
    const row = await svc.requestDisbursement(id);
    expect(row.mode).toBe('MANUAL');
    expect(createDisbursementMock).not.toHaveBeenCalled();
  });

  // ---- reject / fail frees balance ---------------------------------------

  it('failed Xendit call frees the held balance (FAILED excluded)', async () => {
    const id = await member({ balance: 50_000, priorPaid: true });
    createDisbursementMock.mockRejectedValueOnce(new Error('INSUFFICIENT_BALANCE'));
    const row = await svc.requestDisbursement(id); // AUTO → Xendit throws → FAILED
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/INSUFFICIENT_BALANCE/);
    expect(await svc.getWithdrawableBalance(id)).toBe(50_000);
  });

  // ---- callback by externalId (idempotent) -------------------------------

  it('markPaidByExternalId transitions PROCESSING → PAID and is idempotent', async () => {
    const id = await member({ balance: 50_000, priorPaid: true });
    const row = await svc.requestDisbursement(id); // AUTO → PROCESSING
    expect(row.status).toBe('PROCESSING');

    const r1 = await svc.markPaidByExternalId(row.externalId!, 'xendit-disb-1');
    expect(r1.count).toBe(1);
    const after = await prisma.affiliateDisbursement.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe('PAID');
    expect(after?.paidAt).not.toBeNull();

    // Replay → 0 rows, no double-pay.
    const r2 = await svc.markPaidByExternalId(row.externalId!, 'xendit-disb-1');
    expect(r2.count).toBe(0);
  });

  it('markFailedByExternalId transitions PROCESSING → FAILED and frees balance', async () => {
    const id = await member({ balance: 50_000, priorPaid: true });
    const row = await svc.requestDisbursement(id); // AUTO → PROCESSING, holds 50k
    expect(await svc.getWithdrawableBalance(id)).toBe(0);

    const r = await svc.markFailedByExternalId(row.externalId!, 'BANK_REJECTED');
    expect(r.count).toBe(1);
    expect(await svc.getWithdrawableBalance(id)).toBe(50_000);

    // Replay → 0 rows.
    const r2 = await svc.markFailedByExternalId(row.externalId!, 'BANK_REJECTED');
    expect(r2.count).toBe(0);
  });
});
