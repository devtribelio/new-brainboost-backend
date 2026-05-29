import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { prisma } from '@bb/db';
import { BadRequestException } from '@/common/exceptions';
import { logger } from '@/config/logger';
import { mailer } from './mailer.service';

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
}

const DEFAULT_TTL: Record<OtpPurpose, number> = {
  'forgot-password': 10 * 60,
  'delete-account': 60,
  'pre-registration': 15 * 60,
  'verify-phone': 10 * 60,
  'verify-email': 10 * 60,
};

function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

function isEmail(target: string): boolean {
  return target.includes('@');
}

class OtpService {
  async issue(input: IssueOtpInput): Promise<{ id: string; code: string }> {
    const ttl = input.ttlSeconds ?? DEFAULT_TTL[input.purpose];
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const row = await prisma.otpCode.create({
      data: {
        target: input.target,
        code: codeHash,
        purpose: input.purpose,
        expiresAt,
      },
    });

    if (isEmail(input.target)) {
      const subject = input.emailSubject ?? this.defaultSubject(input.purpose);
      const body = input.emailBody?.(code) ?? this.defaultBody(input.purpose, code);
      await mailer.send({ to: input.target, subject, text: body });
    }

    return { id: row.id, code };
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

  private defaultBody(purpose: OtpPurpose, code: string): string {
    switch (purpose) {
      case 'forgot-password':
        return `Your password reset code is ${code}. It expires in 10 minutes.`;
      case 'delete-account':
        return `Your account deletion code is ${code}. It expires in 1 minute. If you did not request this, change your password immediately.`;
      case 'pre-registration':
        return `Your registration code is ${code}. It expires in 15 minutes.`;
      default:
        return `Your verification code is ${code}.`;
    }
  }
}

export const otpService = new OtpService();
