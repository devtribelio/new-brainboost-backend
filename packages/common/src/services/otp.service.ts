import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { prisma } from '@bb/db';
import { badRequest, ERROR_CODES } from '@bb/common/exceptions';
import { logger } from '@bb/common/config/logger';
import { testAccountConfig } from '@bb/common/config/env';
import { enqueueComms } from './comms-outbox';

const MAX_OTP_ATTEMPTS = 5;

/**
 * Minimum gap between two sends of the same target+purpose.
 *
 * Deliberately DECOUPLED from `ttlSeconds`. The two answer different questions:
 * TTL is "how long may this code be redeemed" (wants to be long enough that a
 * WhatsApp/email actually arrives and gets read), cooldown is "how soon may we
 * send again" (wants to be short so a user who never received the message is
 * not stranded). The previous guard checked `expiresAt > now`, which fused them
 * into one number and forced a 10-minute wait before a forgot-password resend.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Default send cap per target+purpose, by delivery channel. WhatsApp (Qontak)
 * is billed per message, email (SES) is effectively free — and email is the
 * channel most likely to be delayed, so it gets the bigger budget.
 */
export const OTP_MAX_PER_DAY = { whatsapp: 5, email: 10 } as const;

/**
 * Window for the send cap. A ROLLING 24h, not a calendar day: the old
 * `setHours(0,0,0,0)` boundary depended on the server's local timezone (a UTC
 * container resets at 07:00 WIB) and let a burst of `maxPerDay` just before
 * midnight be followed by another right after.
 */
const OTP_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Retry hint for a throttled send. The ISO timestamp is for logs/debugging; the
 * seconds field is what a client needs to render a countdown. Neither goes in
 * the user-facing sentence.
 */
function retryDetails(retryAt: Date, now: Date): Record<string, unknown> {
  return {
    retryAfter: retryAt.toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)),
  };
}

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
   * Max OTP requests allowed per target+purpose in a rolling 24h window.
   * Defaults to the channel cap (`OTP_MAX_PER_DAY`) — both the cap and the
   * cooldown are opt-OUT, because every caller that had to opt in forgot to:
   * four of the eight send endpoints shipped with no throttle at all.
   * Pass 0 to disable (tests only).
   */
  maxPerDay?: number;
  /**
   * Minimum seconds since the previous send for this target+purpose, measured
   * from its `createdAt` — independent of `ttlSeconds`. Defaults to
   * `OTP_RESEND_COOLDOWN_SECONDS`. Pass 0 to disable (tests only).
   */
  resendCooldownSeconds?: number;
}

// verify-phone is 2 min to match legacy (CCarbon::now()->addMinutes(2)).
const DEFAULT_TTL: Record<OtpPurpose, number> = {
  'forgot-password': 10 * 60,
  'delete-account': 60,
  'pre-registration': 15 * 60,
  'verify-phone': 2 * 60,
  'verify-email': 10 * 60,
};

// 6 digits on every channel (email used to be 4 — unified 2026-06-11).
function generateCode(): string {
  const min = 10 ** 5;
  return String(randomInt(min, min * 10));
}

function isEmail(target: string): boolean {
  return target.includes('@');
}

/**
 * Canonical form of an OTP target. Email is case-insensitive by RFC, but every
 * lookup here is an exact string match on `otp_codes.target`, so `John@x.com`
 * and `john@x.com` are two unrelated targets: the code issued against one is
 * OTP_NOT_FOUND against the other, and each gets its own cooldown + 24h cap
 * budget. Normalising in the service (rather than at each DTO) covers callers
 * that pass a target straight from the request — `/auth/validateOtp` did, and
 * that is where users hit this — as well as those passing `member.email`
 * verbatim from a legacy row. Phone targets pass through untouched: they are
 * already canonicalised to E.164 by `otpPhoneTarget()`.
 */
function canonicalTarget(target: string): string {
  const t = target.trim();
  return isEmail(t) ? t.toLowerCase() : t;
}

class OtpService {
  /**
   * A tester target is matched (case-insensitively) against the env whitelist.
   * Returns false unless the bypass is explicitly enabled. See docs/test-account.md.
   */
  private isTestTarget(target: string): boolean {
    const cfg = testAccountConfig();
    if (!cfg.enabled || cfg.identifiers.length === 0) return false;
    const t = target.trim().toLowerCase();
    if (cfg.identifiers.includes(t)) return true;
    // Phone OTP targets are canonical E.164 ('+628111…'). Match any phone-form
    // whitelist entry with the same digits so '628111…' / '+62 8111…' all work.
    // Emails (containing '@') only ever match exactly above — never by digits.
    if (t.includes('@')) return false;
    const tDigits = t.replace(/\D/g, '');
    if (!tDigits) return false;
    return cfg.identifiers.some((id) => !id.includes('@') && id.replace(/\D/g, '') === tDigits);
  }

  /** True only when the target is a whitelisted tester AND the fixed code matches. */
  private isTestBypass(target: string, code: string): boolean {
    return this.isTestTarget(target) && code === testAccountConfig().code;
  }

  async issue(rawInput: IssueOtpInput): Promise<{ id: string; code: string; expiresAt: Date }> {
    const input = { ...rawInput, target: canonicalTarget(rawInput.target) };
    const now = new Date();

    // Tester account (e.g. Apple App Review): no real OTP is generated, stored,
    // or delivered — the reviewer enters the fixed code (env TEST_ACCOUNT_OTP_CODE).
    // Skipping issuance also sidesteps the resend guard + daily cap so the reviewer
    // can re-request freely. See docs/test-account.md.
    if (this.isTestTarget(input.target)) {
      const ttl = input.ttlSeconds ?? DEFAULT_TTL[input.purpose];
      logger.info(
        { purpose: input.purpose, target: input.target },
        'OTP issue bypassed for tester account (no code stored, no delivery)',
      );
      return {
        id: 'test-account-bypass',
        code: testAccountConfig().code,
        expiresAt: new Date(now.getTime() + ttl * 1000),
      };
    }

    // Resend cooldown, measured from the last SEND — not from the previous
    // code's expiry, and not skipped when that code was consumed: what is being
    // throttled is the outbound message, so a code's redemption state is
    // irrelevant. See OTP_RESEND_COOLDOWN_SECONDS.
    const cooldownSeconds = input.resendCooldownSeconds ?? OTP_RESEND_COOLDOWN_SECONDS;
    if (cooldownSeconds > 0) {
      const cooldownMs = cooldownSeconds * 1000;
      const last = await prisma.otpCode.findFirst({
        where: {
          target: input.target,
          purpose: input.purpose,
          createdAt: { gt: new Date(now.getTime() - cooldownMs) },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last) {
        throw badRequest(
          ERROR_CODES.OTP_RESEND_TOO_SOON,
          retryDetails(new Date(last.createdAt.getTime() + cooldownMs), now),
        );
      }
    }

    // Send cap per target+purpose over a rolling 24h window.
    const maxPerDay =
      input.maxPerDay ??
      (isEmail(input.target) ? OTP_MAX_PER_DAY.email : OTP_MAX_PER_DAY.whatsapp);
    if (maxPerDay > 0) {
      const where = {
        target: input.target,
        purpose: input.purpose,
        createdAt: { gte: new Date(now.getTime() - OTP_CAP_WINDOW_MS) },
      };
      const issued = await prisma.otpCode.count({ where });
      if (issued >= maxPerDay) {
        // The row that has to age out of the window before a slot frees up.
        // `skip` handles a backlog left by rows issued before this cap existed.
        const blocking = await prisma.otpCode.findFirst({
          where,
          orderBy: { createdAt: 'asc' },
          skip: issued - maxPerDay,
          select: { createdAt: true },
        });
        const freesAt = (blocking?.createdAt ?? now).getTime() + OTP_CAP_WINDOW_MS;
        throw badRequest(ERROR_CODES.OTP_DAILY_LIMIT_REACHED, retryDetails(new Date(freesAt), now));
      }
    }

    const ttl = input.ttlSeconds ?? DEFAULT_TTL[input.purpose];
    const emailTarget = isEmail(input.target);
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(now.getTime() + ttl * 1000);

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
    // outbox — no dual-write race). The comms-relay publishes to SQS; bb-comms
    // delivers (WhatsApp via Qontak / email via SES). See docs/adr/0002.
    const row = await prisma.$transaction(async (tx) => {
      // Supersede every code still live for this target+purpose. Now that a
      // resend no longer waits for the old code to expire, two live rows would
      // otherwise be the norm — and `resolveAndMatch` only ever reads the
      // newest, so the older row is unreachable for a legitimate user yet
      // becomes reachable again the moment the newest is locked by
      // MAX_OTP_ATTEMPTS, handing an attacker a fresh 5-guess budget.
      // `usedAt` doubles as the superseded marker: there is no column for it,
      // and both states mean exactly "no longer redeemable".
      await tx.otpCode.updateMany({
        where: { target: input.target, purpose: input.purpose, usedAt: null },
        data: { usedAt: now },
      });
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
   * issue(), except that while the cooldown is running and the code sent then
   * is still redeemable, this returns THAT code's expiry instead of throwing.
   *
   * For endpoints that mutate state before sending — both register paths
   * overwrite an unverified placeholder row — throwing strands the client with
   * a 400 even though the write landed, and the user already has a perfectly
   * good code on their phone. Endpoints whose only job is to send (the
   * requestVerification* / forgot-password family) keep using issue(), so the
   * user is told to wait rather than silently handed a stale expiry.
   */
  async issueOrReuse(rawInput: IssueOtpInput): Promise<{ expiresAt: Date; reused: boolean }> {
    const input = { ...rawInput, target: canonicalTarget(rawInput.target) };
    const cooldownSeconds = input.resendCooldownSeconds ?? OTP_RESEND_COOLDOWN_SECONDS;
    if (cooldownSeconds > 0) {
      const now = new Date();
      const live = await prisma.otpCode.findFirst({
        where: {
          target: input.target,
          purpose: input.purpose,
          usedAt: null,
          expiresAt: { gt: now },
          createdAt: { gt: new Date(now.getTime() - cooldownSeconds * 1000) },
        },
        orderBy: { createdAt: 'desc' },
        select: { expiresAt: true },
      });
      if (live) return { expiresAt: live.expiresAt, reused: true };
    }
    const { expiresAt } = await this.issue(input);
    return { expiresAt, reused: false };
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

    if (!otp) throw badRequest(ERROR_CODES.OTP_NOT_FOUND);
    if (otp.expiresAt < new Date()) throw badRequest(ERROR_CODES.OTP_EXPIRED);
    if (otp.attempts >= MAX_OTP_ATTEMPTS) {
      throw badRequest(ERROR_CODES.OTP_LOCKED);
    }

    const matches = await bcrypt.compare(code, otp.code);
    if (!matches) {
      // Tell "you typed the PREVIOUS code" apart from "you typed a wrong code".
      // With a 60s cooldown under a multi-minute TTL, a resend routinely races
      // the first message: the user enters a code they legitimately received,
      // just no longer the newest one. Charging an attempt would spend the live
      // code's budget on that, and OTP_INVALID ("wrong code") would be a lie.
      if (await this.matchesSupersededCode(target, purpose, code, otp.id)) {
        throw badRequest(ERROR_CODES.OTP_EXPIRED);
      }
      const attempts = otp.attempts + 1;
      const locked = attempts >= MAX_OTP_ATTEMPTS;
      await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts, ...(locked ? { usedAt: new Date() } : {}) },
      });
      if (locked) {
        logger.warn({ purpose, target }, 'OTP locked after too many incorrect attempts');
        throw badRequest(ERROR_CODES.OTP_LOCKED);
      }
      throw badRequest(ERROR_CODES.OTP_INVALID);
    }

    return { id: otp.id };
  }

  /**
   * True when `code` matches a recently retired row (superseded by a resend, or
   * already consumed) rather than the live one. Bounded to the last 2 retired
   * rows because each check is a bcrypt compare, and only ever runs on the
   * failure path.
   */
  private async matchesSupersededCode(
    target: string,
    purpose: OtpPurpose,
    code: string,
    currentId: string,
  ): Promise<boolean> {
    const retired = await prisma.otpCode.findMany({
      where: { target, purpose, usedAt: { not: null }, id: { not: currentId } },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { code: true },
    });
    for (const row of retired) {
      if (await bcrypt.compare(code, row.code)) return true;
    }
    return false;
  }

  async verify(rawTarget: string, code: string, purpose: OtpPurpose): Promise<void> {
    const target = canonicalTarget(rawTarget);
    if (this.isTestBypass(target, code)) return;
    await this.resolveAndMatch(target, code, purpose);
  }

  async consume(rawTarget: string, code: string, purpose: OtpPurpose): Promise<void> {
    const target = canonicalTarget(rawTarget);
    if (this.isTestBypass(target, code)) {
      // A tester normally has no stored OTP (issue() is bypassed), but clear any
      // stray outstanding code so state stays clean and re-usable.
      await prisma.otpCode.updateMany({
        where: { target, purpose, usedAt: null },
        data: { usedAt: new Date() },
      });
      return;
    }

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
