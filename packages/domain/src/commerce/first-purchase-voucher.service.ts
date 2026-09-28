import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { enqueueComms } from '@bb/common/services/comms-outbox';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import type { CommsChannel } from '@bb/common/mq/comms-contract';
import { FIRST_PURCHASE_CAMPAIGN } from './voucher.service';

export { FIRST_PURCHASE_CAMPAIGN };

/** Which purchase earned the voucher — reporting only, never a rule. */
export type FirstPurchaseSource = 'APP' | 'LEGACY';

export type IssueOutcome =
  /** Voucher row written and the message enqueued. */
  | 'issued'
  /** Member already holds a FIRST_PURCHASE voucher — the lifetime cap held. */
  | 'duplicate'
  /** No email AND no phone: nowhere to send it, so nothing is written. */
  | 'no_contact';

/**
 * Program values, read from `app_settings` at issue time and COPIED onto each row.
 * Copied, not referenced: changing the discount next month must not silently
 * change what a voucher already in somebody's inbox is worth.
 */
export interface FirstPurchaseVoucherConfig {
  type: 'PERCENT' | 'AMOUNT';
  value: number;
  /** PERCENT cap in IDR. Null = uncapped — the only value allowed to be empty. */
  maxAmount: number | null;
  validityDays: number;
}

/**
 * Voucher code alphabet: no 0/O and no 1/I, same reasoning as `generateTicketCode`.
 * This code is read off an email or a WhatsApp message and typed by hand into a
 * checkout form, which is exactly where those pairs get confused.
 *
 * 32^8 ≈ 1.1e12. Uniqueness is still the DB's job (`vouchers.code` UNIQUE); the
 * caller retries on P2002.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_RETRIES = 5;

export function generateVoucherCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Read the program config, or null when it is not fully filled in.
 *
 * Every value except `maxAmount` is required and ships EMPTY — there is deliberately
 * no business default anywhere in this repo, because a dev-chosen placeholder is how
 * a number nobody approved ends up on thousands of vouchers. A half-configured
 * program issues nothing at all rather than issuing something wrong.
 */
export async function loadProgramConfig(): Promise<FirstPurchaseVoucherConfig | null> {
  const [rawType, rawValue, rawMax, rawDays] = await Promise.all([
    settingsService.get(SETTING_KEYS.firstPurchaseVoucherType, ''),
    settingsService.get(SETTING_KEYS.firstPurchaseVoucherValue, ''),
    settingsService.get(SETTING_KEYS.firstPurchaseVoucherMaxAmount, ''),
    settingsService.get(SETTING_KEYS.firstPurchaseVoucherValidityDays, ''),
  ]);

  const type = rawType.trim().toUpperCase();
  if (type !== 'PERCENT' && type !== 'AMOUNT') return null;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return null;

  const validityDays = Number(rawDays);
  if (!Number.isInteger(validityDays) || validityDays <= 0) return null;

  // The one value allowed to be empty: an uncapped PERCENT voucher is a legitimate
  // choice. A non-numeric string is not, and must not quietly read as "uncapped".
  let maxAmount: number | null = null;
  if (rawMax.trim() !== '') {
    const parsed = Number(rawMax);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    maxAmount = Math.floor(parsed);
  }

  return { type, value: Math.floor(value), maxAmount, validityDays };
}

/** `launchAt`, or null when unset/unparseable — either way the job must not run. */
export async function loadLaunchAt(): Promise<Date | null> {
  const raw = (await settingsService.get(SETTING_KEYS.firstPurchaseVoucherLaunchAt, '')).trim();
  if (raw === '') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Issue one member's first-purchase voucher and enqueue the message that carries it.
 *
 * Idempotent by construction: `vouchers` is unique on `(owner_member_id, campaign)`,
 * so a second call — a re-run of the sweep, two ticks racing, a candidate matched by
 * both the new and the legacy source — lands on that constraint and returns
 * `duplicate` instead of a second code.
 *
 * Row and message are written in ONE transaction. A voucher with no message is a
 * discount nobody knows they have; a message with no voucher is a code that does not
 * work. If the enqueue fails the row rolls back and the next sweep tries again,
 * which is safe precisely because the unique guard makes a retry free.
 */
export async function issueForMember(
  memberId: string,
  source: FirstPurchaseSource,
  cfg: FirstPurchaseVoucherConfig,
  now: Date = new Date(),
): Promise<IssueOutcome> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, email: true, phone: true },
  });
  if (!member) return 'no_contact';

  // Email first, WhatsApp only as fallback (P10). WhatsApp is deliberately not the
  // primary channel: this is a MARKETING-category template sharing a business number
  // with OTP, so reports and blocks from recipients drag down the quality rating that
  // OTP delivery depends on.
  const channel: CommsChannel | null = member.email
    ? 'email'
    : member.phone
      ? 'whatsapp'
      : null;
  if (!channel) return 'no_contact';

  // Cheap pre-check so the common repeat is one SELECT rather than a failed INSERT.
  // It is NOT the guarantee — the unique index below is, and it is what holds when
  // two ticks overlap.
  const existing = await prisma.voucher.findFirst({
    where: { ownerMemberId: memberId, campaign: FIRST_PURCHASE_CAMPAIGN },
    select: { id: true },
  });
  if (existing) return 'duplicate';

  const endsAt = new Date(now.getTime() + cfg.validityDays * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < CODE_RETRIES; attempt++) {
    const code = generateVoucherCode();
    try {
      await prisma.$transaction(async (tx) => {
        const voucher = await tx.voucher.create({
          data: {
            code,
            type: cfg.type,
            value: cfg.value,
            maxAmount: cfg.maxAmount,
            quota: 1,
            isActive: true,
            startsAt: now,
            endsAt,
            ownerMemberId: memberId,
            campaign: FIRST_PURCHASE_CAMPAIGN,
            ownerSource: source,
            sentChannel: channel,
          },
          select: { id: true },
        });
        // bb-comms reads the code, value and expiry back from `vouchers` by refId —
        // nothing about the offer travels in the payload, so a resend from the
        // backoffice is just another row with the same refId.
        await enqueueComms({ type: 'FirstPurchaseVoucher', channel, refId: voucher.id }, tx);
      });
      return 'issued';
    } catch (e) {
      const target = p2002Target(e);
      if (target === '') throw e;
      // Lost the lifetime-cap race — another tick issued first. Not an error.
      if (target.includes('owner_member_id') || target.includes('campaign')) return 'duplicate';
      if (!target.includes('code')) throw e;
      logger.warn({ memberId, attempt }, '[first-purchase-voucher] code collision, retrying');
    }
  }
  throw new Error(`could not mint a unique voucher code after ${CODE_RETRIES} attempts`);
}

/** Constraint/columns a P2002 fired on, or '' when the error is something else. */
function p2002Target(e: unknown): string {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return '';
  const target = (e.meta as { target?: string | string[] } | undefined)?.target;
  return Array.isArray(target) ? target.join(',') : (target ?? 'unknown');
}
