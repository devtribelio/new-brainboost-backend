/**
 * executeApprovedDisbursements job (backoffice MANUAL-approval sweep).
 *
 * Member-scoped only (safe on shared/staging DB): seeds its own members +
 * disbursement rows and asserts on those rows only — the job may pick up
 * other PENDING+approved rows on a shared DB, so counts are not asserted
 * globally. The Xendit client is MOCKED — NO real disbursement is created.
 *
 * Requires a reachable Postgres test DB (DATABASE_URL).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

// Mock the Xendit disbursement client BEFORE the service imports it.
const { createDisbursementMock } = vi.hoisted(() => ({ createDisbursementMock: vi.fn() }));
vi.mock('@bb/common/services/xendit.client', () => ({
  createDisbursement: createDisbursementMock,
}));

import { prisma } from '@bb/db';
import { executeApprovedDisbursements } from '@bb/domain/jobs/execute-approved-disbursements';

const TAG = `disbexec-${Date.now()}`;

async function makeMember(kyc = 'APPROVED'): Promise<string> {
  const m = await prisma.member.create({
    data: {
      email: `${TAG}-${randomUUID()}@disbexec.local`,
      passwordHash: await bcrypt.hash('x', 4),
      kycStatus: kyc,
      bankCode: 'BCA',
      bankAccountNumber: '1234567890',
      bankAccountName: 'TEST USER',
    },
  });
  return m.id;
}

async function makeRow(
  memberId: string,
  opts: { approved?: boolean; status?: string } = {},
): Promise<string> {
  const row = await prisma.affiliateDisbursement.create({
    data: {
      memberId,
      grossAmount: 20_000,
      fee: 5_000,
      netAmount: 15_000,
      status: opts.status ?? 'PENDING',
      mode: 'MANUAL',
      externalId: `${TAG}-${randomUUID()}`,
      bankCode: 'BCA',
      bankAccountNumber: '1234567890',
      bankAccountName: 'TEST USER',
      ...(opts.approved ? { approvedAt: new Date() } : {}),
    },
  });
  return row.id;
}

const rowById = (id: string) =>
  prisma.affiliateDisbursement.findUniqueOrThrow({ where: { id } });

beforeEach(() => {
  createDisbursementMock.mockReset();
  createDisbursementMock.mockResolvedValue({ id: `xnd-${randomUUID()}`, status: 'PENDING', raw: {} });
});

afterAll(async () => {
  await prisma.affiliateDisbursement.deleteMany({ where: { externalId: { startsWith: TAG } } });
  await prisma.member.deleteMany({ where: { email: { contains: TAG } } });
});

describe('executeApprovedDisbursements', () => {
  it('sends an approved PENDING row to Xendit and flips it to PROCESSING', async () => {
    const memberId = await makeMember();
    const id = await makeRow(memberId, { approved: true });

    await executeApprovedDisbursements();

    const row = await rowById(id);
    expect(row.status).toBe('PROCESSING');
    expect(row.provider).toBe('xendit');
    expect(row.providerRef).toMatch(/^xnd-/);
    expect(createDisbursementMock).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: row.externalId, amount: 15_000, bankCode: 'BCA' }),
    );
  });

  it('leaves unapproved PENDING rows untouched', async () => {
    const memberId = await makeMember();
    const id = await makeRow(memberId, { approved: false });

    await executeApprovedDisbursements();

    const row = await rowById(id);
    expect(row.status).toBe('PENDING');
    expect(
      createDisbursementMock.mock.calls.some((c) => c[0].externalId === row.externalId),
    ).toBe(false);
  });

  it('fails (frees balance) instead of paying when KYC is no longer APPROVED', async () => {
    const memberId = await makeMember('EXPIRED');
    const id = await makeRow(memberId, { approved: true });

    const res = await executeApprovedDisbursements();

    const row = await rowById(id);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toContain('KYC');
    expect(row.failureReason).toContain('EXPIRED');
    expect(res.kycBlocked).toBeGreaterThanOrEqual(1);
    expect(
      createDisbursementMock.mock.calls.some((c) => c[0].externalId === row.externalId),
    ).toBe(false);
  });

  it('marks the row FAILED when Xendit rejects the call', async () => {
    const memberId = await makeMember();
    const id = await makeRow(memberId, { approved: true });
    createDisbursementMock.mockRejectedValue(new Error('BANK_CODE_NOT_SUPPORTED'));

    await executeApprovedDisbursements();

    const row = await rowById(id);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('BANK_CODE_NOT_SUPPORTED');
  });

  it('does not touch terminal rows even with approvedAt set', async () => {
    const memberId = await makeMember();
    const id = await makeRow(memberId, { approved: true, status: 'REJECTED' });

    await executeApprovedDisbursements();

    const row = await rowById(id);
    expect(row.status).toBe('REJECTED');
  });
});
