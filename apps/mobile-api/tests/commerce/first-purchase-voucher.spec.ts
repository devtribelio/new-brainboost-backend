import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma } from '@bb/db';
import { SettingsService, SETTING_KEYS, settingsService } from '@bb/common/services/settings.service';
import { ERROR_CODES } from '@bb/common/exceptions';
import { VoucherService, FIRST_PURCHASE_CAMPAIGN } from '@bb/domain/commerce/voucher.service';
import { firstPurchaseVoucher } from '@bb/domain/jobs/first-purchase-voucher';

/** Launch date of the fictional program; every date below is relative to it. */
const LAUNCH = new Date('2026-09-01T00:00:00Z');
const BEFORE_LAUNCH = new Date('2026-08-20T00:00:00Z');
const AFTER_LAUNCH = new Date('2026-09-05T00:00:00Z');
const NOW = new Date('2026-09-15T10:00:00Z');

const VALIDITY_DAYS = 30;

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

const memberIds: string[] = [];
const productIds: string[] = [];

async function member(opts: { email?: boolean; phone?: boolean } = {}): Promise<string> {
  const withEmail = opts.email ?? true;
  const withPhone = opts.phone ?? false;
  const tag = uid();
  const m = await prisma.member.create({
    data: {
      email: withEmail ? `fpv-${tag}@test.local` : null,
      phone: withPhone ? `8${Date.now()}${Math.floor(Math.random() * 900 + 100)}`.slice(0, 14) : null,
      phoneCode: withPhone ? '+62' : null,
      passwordHash: 'x',
      fullName: `FPV ${tag}`,
    },
  });
  memberIds.push(m.id);
  return m.id;
}

/** A product WITH a `courses` row — the only thing that makes it a course purchase. */
async function courseProduct(price = 500_000): Promise<{ productId: string; courseId: string }> {
  const p = await prisma.product.create({
    data: { type: 'course', title: `FPV course ${uid()}`, price, isActive: true, status: 'active' },
  });
  productIds.push(p.id);
  const c = await prisma.course.create({ data: { productId: p.id } });
  return { productId: p.id, courseId: c.id };
}

/**
 * A mini course. It HAS a `courses` row and enrolls like any other course, and is
 * still outside the discount scope — which is the whole reason the gate reads
 * `products.type` instead of the course row.
 */
async function miniCourseProduct(): Promise<string> {
  const p = await prisma.product.create({
    data: {
      type: 'mini_course',
      title: `FPV mini ${uid()}`,
      price: 100_000,
      isActive: true,
      status: 'active',
    },
  });
  productIds.push(p.id);
  await prisma.course.create({ data: { productId: p.id } });
  return p.id;
}

/** A product with NO `courses` row — stands in for an event ticket. */
async function ticketProduct(): Promise<string> {
  const p = await prisma.product.create({
    data: {
      type: 'event_ticket',
      title: `FPV ticket ${uid()}`,
      price: 200_000,
      isActive: true,
      status: 'active',
    },
  });
  productIds.push(p.id);
  return p.id;
}

async function paidOrder(memberId: string, productId: string, paidAt: Date, amount = 500_000) {
  return prisma.commerceTransaction.create({
    data: {
      code: `FPV-${uid()}`,
      memberId,
      productId,
      qty: 1,
      itemTotal: amount,
      amount,
      status: 'PAID',
      paidAt,
    },
  });
}

async function legacyEnrollment(
  memberId: string,
  courseId: string,
  dateStart: Date | null,
  extra: { expiredDate?: Date; isCanceled?: boolean } = {},
) {
  return prisma.courseEnrollment.create({
    data: {
      legacyId: Math.floor(Math.random() * 2_000_000_000),
      memberId,
      courseId,
      dateStart,
      expiredDate: extra.expiredDate ?? null,
      isCanceled: extra.isCanceled ?? false,
    },
  });
}

async function vouchersOf(memberId: string) {
  return prisma.voucher.findMany({ where: { ownerMemberId: memberId } });
}

async function configureProgram(over: Partial<Record<string, string>> = {}): Promise<void> {
  const values: Record<string, string> = {
    [SETTING_KEYS.firstPurchaseVoucherEnabled]: 'true',
    [SETTING_KEYS.firstPurchaseVoucherLaunchAt]: LAUNCH.toISOString(),
    [SETTING_KEYS.firstPurchaseVoucherType]: 'PERCENT',
    [SETTING_KEYS.firstPurchaseVoucherValue]: '10',
    [SETTING_KEYS.firstPurchaseVoucherMaxAmount]: '50000',
    [SETTING_KEYS.firstPurchaseVoucherValidityDays]: String(VALIDITY_DAYS),
    // Always cleared: the job writes it, so one test's watermark would otherwise
    // hide the next test's candidates.
    [SETTING_KEYS.firstPurchaseVoucherLastSweepAt]: '',
    ...over,
  };
  for (const [key, value] of Object.entries(values)) await settingsService.set(key, value);
  SettingsService.clearCache();
}

describe('first-purchase voucher (real Postgres)', () => {
  beforeAll(async () => {
    await configureProgram();
  });

  beforeEach(async () => {
    await configureProgram();
  });

  afterAll(async () => {
    const vouchers = await prisma.voucher.findMany({
      where: { ownerMemberId: { in: memberIds } },
      select: { id: true },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { refId: { in: vouchers.map((v) => v.id) } },
    });
    await prisma.voucher.deleteMany({ where: { ownerMemberId: { in: memberIds } } });
    await prisma.courseEnrollment.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.commerceTransaction.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.course.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.appSetting.deleteMany({
      where: { key: { startsWith: 'firstPurchaseVoucher.' } },
    });
  });

  describe('job: who qualifies', () => {
    it('issues one voucher for a first paid course order after launch', async () => {
      const m = await member();
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.issued).toBe(1);

      const [voucher] = await vouchersOf(m);
      expect(voucher).toMatchObject({
        campaign: FIRST_PURCHASE_CAMPAIGN,
        ownerSource: 'APP',
        sentChannel: 'email',
        type: 'PERCENT',
        value: 10,
        maxAmount: 50_000,
        quota: 1,
        used: 0,
        isActive: true,
      });
      expect(voucher!.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(voucher!.endsAt!.getTime()).toBe(NOW.getTime() + VALIDITY_DAYS * 86_400_000);

      const outbox = await prisma.notificationOutbox.findMany({ where: { refId: voucher!.id } });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ type: 'FirstPurchaseVoucher', channel: 'email' });
    });

    it('skips a member who already bought before launch', async () => {
      const m = await member();
      const before = await courseProduct();
      const after = await courseProduct();
      await paidOrder(m, before.productId, BEFORE_LAUNCH);
      await paidOrder(m, after.productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.issued).toBe(0);
      expect(await vouchersOf(m)).toHaveLength(0);
    });

    it('does not count a free order, a legacy trial, or a free legacy course', async () => {
      const free = await member();
      const { productId } = await courseProduct();
      await paidOrder(free, productId, AFTER_LAUNCH, 0); // 100% voucher / trial bypass

      const trial = await member();
      const trialCourse = await courseProduct();
      await legacyEnrollment(trial, trialCourse.courseId, AFTER_LAUNCH, {
        expiredDate: new Date('2026-09-20T00:00:00Z'),
      });

      const freeCourse = await member();
      const zeroPriced = await courseProduct(0);
      await legacyEnrollment(freeCourse, zeroPriced.courseId, AFTER_LAUNCH);

      for (const m of [free, trial, freeCourse]) {
        const result = await firstPurchaseVoucher(NOW, { memberId: m });
        expect(result.issued).toBe(0);
        expect(await vouchersOf(m)).toHaveLength(0);
      }
    });

    it('does not count an event ticket order', async () => {
      const m = await member();
      const ticket = await ticketProduct();
      await paidOrder(m, ticket, AFTER_LAUNCH, 200_000);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.issued).toBe(0);
      expect(await vouchersOf(m)).toHaveLength(0);
    });

    it('does not count an enrollment legacy removed (is_canceled)', async () => {
      const m = await member();
      const { courseId } = await courseProduct();
      await legacyEnrollment(m, courseId, AFTER_LAUNCH, { isCanceled: true });

      expect((await firstPurchaseVoucher(NOW, { memberId: m })).issued).toBe(0);
    });

    it('issues with ownerSource LEGACY for a resynced Tribelio enrollment', async () => {
      const m = await member();
      const { courseId } = await courseProduct();
      await legacyEnrollment(m, courseId, AFTER_LAUNCH);

      expect((await firstPurchaseVoucher(NOW, { memberId: m })).issued).toBe(1);
      const [voucher] = await vouchersOf(m);
      expect(voucher!.ownerSource).toBe('LEGACY');
    });

    it('issues exactly one voucher to a member matched by both sources', async () => {
      const m = await member();
      const legacyCourse = await courseProduct();
      const appCourse = await courseProduct();
      await legacyEnrollment(m, legacyCourse.courseId, AFTER_LAUNCH);
      await paidOrder(m, appCourse.productId, new Date('2026-09-07T00:00:00Z'));

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.issued).toBe(1);
      const vouchers = await vouchersOf(m);
      expect(vouchers).toHaveLength(1);
      // Earliest purchase wins the source flag.
      expect(vouchers[0]!.ownerSource).toBe('LEGACY');
    });

    it('is idempotent across runs', async () => {
      const m = await member();
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      expect((await firstPurchaseVoucher(NOW, { memberId: m })).issued).toBe(1);
      const second = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(second.issued).toBe(0);
      expect(await vouchersOf(m)).toHaveLength(1);
    });

    it('skips an undatable legacy enrollment rather than guessing its age', async () => {
      const m = await member();
      const undated = await courseProduct();
      const recent = await courseProduct();
      await legacyEnrollment(m, undated.courseId, null);
      await legacyEnrollment(m, recent.courseId, AFTER_LAUNCH);

      expect((await firstPurchaseVoucher(NOW, { memberId: m })).issued).toBe(0);
    });
  });

  describe('job: gates', () => {
    it('writes nothing while disabled', async () => {
      await configureProgram({ [SETTING_KEYS.firstPurchaseVoucherEnabled]: 'false' });
      const m = await member();
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.skipped).toBe('disabled');
      expect(await vouchersOf(m)).toHaveLength(0);
    });

    it('writes nothing while launchAt is unset', async () => {
      await configureProgram({ [SETTING_KEYS.firstPurchaseVoucherLaunchAt]: '' });
      const m = await member();
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.skipped).toBe('not-launched');
      expect(await vouchersOf(m)).toHaveLength(0);
    });

    it('writes nothing while the program values are incomplete', async () => {
      await configureProgram({ [SETTING_KEYS.firstPurchaseVoucherValue]: '' });
      const m = await member();
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.skipped).toBe('misconfigured');
      expect(await vouchersOf(m)).toHaveLength(0);
    });

    it('reports candidates on a dry run without writing', async () => {
      const m = await member();
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m, dryRun: true });
      expect(result.candidates).toBe(1);
      expect(result.preview?.[0]).toMatchObject({ memberId: m, source: 'APP' });
      expect(await vouchersOf(m)).toHaveLength(0);
    });
  });

  describe('job: delivery channel', () => {
    it('falls back to WhatsApp for a member with no email', async () => {
      const m = await member({ email: false, phone: true });
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      expect((await firstPurchaseVoucher(NOW, { memberId: m })).issued).toBe(1);
      const [voucher] = await vouchersOf(m);
      expect(voucher!.sentChannel).toBe('whatsapp');
      const outbox = await prisma.notificationOutbox.findMany({ where: { refId: voucher!.id } });
      expect(outbox[0]!.channel).toBe('whatsapp');
    });

    it('issues nothing to a member with neither email nor phone', async () => {
      const m = await member({ email: false, phone: false });
      const { productId } = await courseProduct();
      await paidOrder(m, productId, AFTER_LAUNCH);

      const result = await firstPurchaseVoucher(NOW, { memberId: m });
      expect(result.noContact).toBe(1);
      expect(result.issued).toBe(0);
      expect(await vouchersOf(m)).toHaveLength(0);
    });
  });

  describe('VoucherService.validate ownership', () => {
    const voucherService = new VoucherService();

    async function ownedVoucher(ownerMemberId: string): Promise<string> {
      const v = await prisma.voucher.create({
        data: {
          code: `OWN${uid().toUpperCase().slice(0, 5)}`,
          type: 'AMOUNT',
          value: 25_000,
          quota: 1,
          ownerMemberId,
          campaign: FIRST_PURCHASE_CAMPAIGN,
          ownerSource: 'APP',
          sentChannel: 'email',
        },
      });
      return v.code;
    }

    it('accepts the owner on a course product', async () => {
      const owner = await member();
      const { productId } = await courseProduct();
      const code = await ownedVoucher(owner);

      const result = await voucherService.validate(code, productId, owner);
      expect(result.valid).toBe(true);
      expect(result.voucherAmount).toBe(25_000);
    });

    it('answers a non-owner exactly as it answers an unknown code', async () => {
      const owner = await member();
      const stranger = await member();
      const { productId } = await courseProduct();
      const code = await ownedVoucher(owner);

      const denied = await voucherService.validate(code, productId, stranger);
      const unknown = await voucherService.validate('NOSUCHCODE', productId, stranger);
      // Byte-for-byte: `reason` reaches the client, so any difference is an oracle.
      expect(denied).toEqual(unknown);
      expect(denied.valid).toBe(false);
    });

    it('hides an expired owned voucher from a non-owner too', async () => {
      const owner = await member();
      const stranger = await member();
      const { productId } = await courseProduct();
      const code = await ownedVoucher(owner);
      await prisma.voucher.update({
        where: { code },
        data: { endsAt: new Date('2020-01-01T00:00:00Z') },
      });

      const denied = await voucherService.validate(code, productId, stranger);
      const unknown = await voucherService.validate('NOSUCHCODE', productId, stranger);
      expect(denied).toEqual(unknown);
    });

    it('tells the owner plainly that the voucher is course-only', async () => {
      const owner = await member();
      const ticket = await ticketProduct();
      const code = await ownedVoucher(owner);

      const result = await voucherService.validate(code, ticket, owner);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.VOUCHER_COURSE_ONLY);
    });

    it('refuses a mini course, course-backed though it is', async () => {
      const owner = await member();
      const mini = await miniCourseProduct();
      const code = await ownedVoucher(owner);

      const result = await voucherService.validate(code, mini, owner);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.VOUCHER_COURSE_ONLY);
    });

    it('leaves an ownerless voucher behaving exactly as before', async () => {
      const anyone = await member();
      const { productId } = await courseProduct();
      const v = await prisma.voucher.create({
        data: { code: `PUB${uid().toUpperCase().slice(0, 5)}`, type: 'AMOUNT', value: 10_000 },
      });

      const result = await voucherService.validate(v.code, productId, anyone);
      expect(result.valid).toBe(true);
      await prisma.voucher.delete({ where: { id: v.id } });
    });
  });
});
