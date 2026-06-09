import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { prisma } from '@bb/db';
import { BadRequestException } from '@bb/common/exceptions';
import { logger } from '@bb/common/config/logger';
import { enqueueComms } from './comms-outbox';

const MAX_OTP_ATTEMPTS = 5;

export type OtpPurpose =
  | 'forgot-password'
  | 'delete-account'
  | 'pre-registration'
  | 'verify-phone'
  | 'verify-email';

export interface IssueOtpInput {
  target: string;
  purpose: OtpPurpose;
  ttlSeconds?: number;
  emailSubject?: string;
  emailBody?: (code: string) => string;
  /** Optional HTML email body (email targets only). */
  emailHtml?: (code: string) => string;
  /** WhatsApp recipient display name (phone targets only). */
  recipientName?: string;
  /**
   * Max OTP requests allowed per target+purpose per calendar day. Mirrors
   * legacy phone-OTP cap (TBApi MemberRequestVerificationPhone: 5/day).
   * Omit to disable the daily cap.
   */
  maxPerDay?: number;
  /**
   * Reject the request while a still-valid (unused, unexpired) OTP exists for
   * this target+purpose. Mirrors legacy resend guard (errCode 2113).
   */
  enforceResendGuard?: boolean;
}

// verify-phone is 2 min to match legacy (CCarbon::now()->addMinutes(2)).
const DEFAULT_TTL: Record<OtpPurpose, number> = {
  'forgot-password': 10 * 60,
  'delete-account': 60,
  'pre-registration': 15 * 60,
  'verify-phone': 2 * 60,
  'verify-email': 10 * 60,
};

function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

function isEmail(target: string): boolean {
  return target.includes('@');
}

class OtpService {
  async issue(input: IssueOtpInput): Promise<{ id: string; code: string; expiresAt: Date }> {
    const now = new Date();

    // Resend guard: a still-valid code must expire (or be consumed) first.
    if (input.enforceResendGuard) {
      const active = await prisma.otpCode.findFirst({
        where: {
          target: input.target,
          purpose: input.purpose,
          usedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (active) {
        throw new BadRequestException(
          `An OTP was already sent. Please retry after ${active.expiresAt.toISOString()}.`,
        );
      }
    }

    // Daily cap per target+purpose (calendar day).
    if (input.maxPerDay !== undefined) {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const issuedToday = await prisma.otpCode.count({
        where: {
          target: input.target,
          purpose: input.purpose,
          createdAt: { gte: startOfDay },
        },
      });
      if (issuedToday >= input.maxPerDay) {
        throw new BadRequestException(
          'You have reached the maximum number of OTP requests for today. Please try again tomorrow.',
        );
      }
    }

    const ttl = input.ttlSeconds ?? DEFAULT_TTL[input.purpose];
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const emailTarget = isEmail(input.target);

    // OTP code is sensitive + can't be re-derived (otp_codes holds only the hash),
    // so it rides inline in the outbox payload. Email subject/body are computed
    // here (the caller's closures can't cross to bb-comms) and carried inline too.
    // text = body message WITHOUT the code — bb-comms renders the branded OTP
    // template (legacy layout: greeting + message + prominent code + expiry).
    // A caller may still pass emailHtml for a full override.
    const emailPayload = emailTarget
      ? {
          code,
          subject: input.emailSubject ?? this.defaultSubject(input.purpose),
          text: input.emailBody?.(code) ?? this.defaultMessage(input.purpose),
          name: input.recipientName ?? '',
          expiredIn: humanTtl(ttl),
          ...(input.emailHtml ? { html: input.emailHtml(code) } : {}),
        }
      : null;

    // Write the otp row AND the comms outbox row in one transaction (transactional
    // outbox — no dual-write race). The comms-relay publishes to RabbitMQ; bb-comms
    // delivers (WhatsApp via Qontak / email via SES). See docs/adr/0002.
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.otpCode.create({
        data: {
          target: input.target,
          code: codeHash,
          purpose: input.purpose,
          expiresAt,
        },
      });
      await enqueueComms(
        {
          type: 'otp',
          channel: emailTarget ? 'email' : 'whatsapp',
          priority: 'urgent',
          recipient: input.target,
          payload: emailPayload ?? { code, name: input.recipientName ?? '', ttl },
        },
        tx,
      );
      return created;
    });

    return { id: row.id, code, expiresAt };
  }

  /**
   * Loads the latest unused OTP and verifies the supplied code against it.
   * Enforces an attempt counter: wrong guesses are counted, and once
   * MAX_OTP_ATTEMPTS is reached the OTP is invalidated so it cannot be
   * brute-forced. Returns the matched OTP row on success.
   */
  private async resolveAndMatch(
    target: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<{ id: string }> {
    const otp = await prisma.otpCode.findFirst({
      where: { target, purpose, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) throw new BadRequestException('OTP not found or already used');
    if (otp.expiresAt < new Date()) throw new BadRequestException('OTP expired');
    if (otp.attempts >= MAX_OTP_ATTEMPTS) {
      throw new BadRequestException('Too many incorrect attempts. Request a new code.');
    }

    const matches = await bcrypt.compare(code, otp.code);
    if (!matches) {
      const attempts = otp.attempts + 1;
      const locked = attempts >= MAX_OTP_ATTEMPTS;
      await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts, ...(locked ? { usedAt: new Date() } : {}) },
      });
      if (locked) {
        logger.warn({ purpose, target }, 'OTP locked after too many incorrect attempts');
        throw new BadRequestException('Too many incorrect attempts. Request a new code.');
      }
      throw new BadRequestException('Invalid OTP');
    }

    return { id: otp.id };
  }

  async verify(target: string, code: string, purpose: OtpPurpose): Promise<void> {
    await this.resolveAndMatch(target, code, purpose);
  }

  async consume(target: string, code: string, purpose: OtpPurpose): Promise<void> {
    const otp = await this.resolveAndMatch(target, code, purpose);

    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });
  }

  private defaultSubject(purpose: OtpPurpose): string {
    switch (purpose) {
      case 'forgot-password':
        return 'Reset your Brainboost password';
      case 'delete-account':
        return 'Confirm Brainboost account deletion';
      case 'pre-registration':
        return 'Verify your Brainboost email';
      case 'verify-phone':
      case 'verify-email':
        return 'Brainboost verification code';
    }
  }

  // Body message WITHOUT the code (the email template displays the code itself).
  // Wording is the legacy TBEmailTemplate copy (MemberRequestForget / MemberVerification).
  private defaultMessage(purpose: OtpPurpose): string {
    switch (purpose) {
      case 'forgot-password':
        return 'Enter the OTP Code we sent to your email below to confirm your new password';
      case 'delete-account':
        return 'Enter the OTP Code below to confirm your account deletion';
      default:
        return 'Enter the OTP Code below to verify your account :';
    }
  }
}

// TTL seconds → human-readable, e.g. 600 → "10 minutes".
function humanTtl(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export const otpService = new OtpService();
