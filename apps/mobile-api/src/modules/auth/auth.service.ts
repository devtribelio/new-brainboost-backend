import bcrypt from 'bcryptjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import passport from 'passport';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import {
  signAccessToken,
  signAnonAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '@bb/common/utils/jwt.util';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@bb/common/exceptions';
import { assertUuid } from '@bb/common/utils/uuid.util';
import { otpService } from '@bb/common/services/otp.service';
import type { GoogleIdTokenPayload } from './social/google-verifier';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { CloudMessagingDto, RegisterDeviceDto } from './dto/device.dto';
import type {
  ForgotPasswordVerificationDto,
  RequestForgotPasswordDto,
  ValidateOtpDto,
} from './dto/forgot-password.dto';
import type { RegisterByPhoneDto } from './dto/register-by-phone.dto';
import type { RequestVerificationPhoneDto } from './dto/request-verification-phone.dto';
import type { ValidateOtpPhoneDto } from './dto/validate-otp-phone.dto';
import { logger } from '@bb/common/config/logger';
import { mailer } from '@bb/common/services/mailer.service';

interface TokenBundle {
  access_token: string;
  refresh_token?: string;
  token_type: 'Bearer';
  /** Seconds until access_token expires. Per OAuth2 RFC 6749 §5.1. */
  expires_in: number;
  scope?: 'member' | 'anon';
}

function parseExpiresInToSeconds(input: string): number {
  const trimmed = input.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return Math.floor(numeric);
  const match = trimmed.match(/^(\d+)\s*([smhd])$/i);
  if (!match) throw new Error(`Invalid expires_in format: ${input}`);
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * multipliers[unit]!;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type ClientType = 'mobile' | 'web';

/**
 * Resolve session bucket. `web` only when explicitly signaled; everything else
 * (including legacy `ios`/`android` from RegisterDto.registerFrom, missing
 * field, or unknown value) falls into the `mobile` bucket so deployed apps
 * keep single-login behavior.
 */
function normalizeClientType(raw: string | null | undefined): ClientType {
  return raw === 'web' ? 'web' : 'mobile';
}

function mapDtoPurpose(
  p: string,
): 'forgot-password' | 'pre-registration' | 'verify-phone' | 'verify-email' {
  switch (p) {
    case 'register':
      return 'pre-registration';
    case 'forgot_password':
      return 'forgot-password';
    case 'verify_phone':
      return 'verify-phone';
    case 'verify_email':
      return 'verify-email';
    default:
      throw new BadRequestException(`Unknown OTP purpose: ${p}`);
  }
}

export class AuthService {
  async login(dto: LoginDto): Promise<TokenBundle> {
    switch (dto.grant_type) {
      case 'password':
        return this.loginWithPassword(dto);
      case 'refresh_token':
        return this.loginWithRefreshToken(dto);
      case 'client_credentials':
        return this.loginWithClientCredentials(dto);
      case 'social':
        return this.loginWithSocial(dto);
      default:
        throw new BadRequestException('Unsupported grant_type');
    }
  }

  private loginWithClientCredentials(dto: LoginDto): TokenBundle {
    const expectedId = env.oauth.clientId;
    const expectedSecret = env.oauth.clientSecret;
    if (!expectedId || !expectedSecret) {
      throw new BadRequestException('client_credentials grant is disabled');
    }
    if (!dto.client_id || !dto.client_secret) {
      throw new BadRequestException('client_id and client_secret required');
    }
    const ok =
      timingSafeStringEqual(dto.client_id, expectedId) &&
      timingSafeStringEqual(dto.client_secret, expectedSecret);
    if (!ok) throw new UnauthorizedException('Invalid client credentials');

    return {
      access_token: signAnonAccessToken(dto.client_id),
      token_type: 'Bearer',
      expires_in: parseExpiresInToSeconds(env.jwt.anonExpiresIn),
      scope: 'anon',
    };
  }

  async register(dto: RegisterDto): Promise<TokenBundle> {
    const conflicts = await prisma.member.findFirst({
      where: {
        OR: [
          { email: dto.email },
          dto.phone ? { phone: dto.phone } : undefined,
          dto.username ? { username: dto.username } : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      },
      select: { email: true, phone: true, username: true },
    });
    if (conflicts) {
      if (conflicts.email === dto.email) throw new BadRequestException('Email already registered');
      if (dto.phone && conflicts.phone === dto.phone) {
        throw new BadRequestException('Phone already registered');
      }
      if (dto.username && conflicts.username === dto.username) {
        throw new BadRequestException('Username already registered');
      }
    }

    if (dto.birthdate) {
      const dob = new Date(dto.birthdate);
      if (Number.isNaN(dob.getTime())) throw new BadRequestException('Invalid birthdate');
      const ageMs = Date.now() - dob.getTime();
      const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
      if (ageYears < 13) throw new BadRequestException('Member must be at least 13 years old');
    }

    let inviterId: string | undefined;
    let inviterNetworkId: string | undefined;
    if (dto.affiliateCode) {
      const codePart = dto.affiliateCode.slice(0, 8);
      const networkLegacyPart = dto.affiliateCode.slice(8);
      const inviter = await prisma.member.findUnique({
        where: { affiliateCode: codePart },
        select: { id: true },
      });
      if (inviter) inviterId = inviter.id;
      if (networkLegacyPart) {
        const networkLegacyId = Number.parseInt(networkLegacyPart, 10);
        if (Number.isFinite(networkLegacyId)) {
          const net = await prisma.network.findUnique({
            where: { legacyId: networkLegacyId },
            select: { id: true },
          });
          if (net) inviterNetworkId = net.id;
        }
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const memberCode = await this.generateUniqueMemberCode();

    const member = await prisma.member.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
        phone: dto.phone,
        phoneCode: dto.phoneCode,
        username: dto.username,
        gender: dto.gender,
        birthdate: dto.birthdate ? new Date(dto.birthdate) : null,
        code: memberCode,
        affiliateCode: memberCode,
        inviterId,
        inviterNetworkId,
        registerFrom: dto.registerFrom,
        utmSource: dto.utmSource,
        utmContent: dto.utmContent,
      },
    });

    if (inviterNetworkId) {
      await prisma.networkMember.upsert({
        where: { networkId_memberId: { networkId: inviterNetworkId, memberId: member.id } },
        create: { networkId: inviterNetworkId, memberId: member.id },
        update: {},
      });
      await prisma.network.update({
        where: { id: inviterNetworkId },
        data: { countMember: { increment: 1 } },
      });
    }

    await this.autoJoinCommunityNetworks(member.id);

    await prisma.praMember.deleteMany({
      where: {
        OR: [
          dto.email ? { email: dto.email } : undefined,
          dto.phone ? { phone: dto.phone } : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      },
    });

    return this.issueTokenBundle(member.id, member.email, normalizeClientType(dto.registerFrom));
  }

  private async generateUniqueMemberCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      const exists = await prisma.member.findFirst({
        where: { OR: [{ code }, { affiliateCode: code }] },
        select: { id: true },
      });
      if (!exists) return code;
    }
    throw new Error('Unable to generate unique member code after 5 attempts');
  }

  // Auto-join the default community networks (Timeline + Education) on every
  // new member. Mirrors what mobile MainPage previously triggered via
  // /api/member/info → /api/network/join, but guarantees the rows exist before
  // the first feed render. Idempotent: per-network unique violation is swallowed
  // so a retried registration cannot double-join or double-bump countMember.
  private async autoJoinCommunityNetworks(memberId: string): Promise<void> {
    const communities = await prisma.network.findMany({
      where: { purpose: { in: ['timeline', 'education'] }, isActive: true },
      select: { id: true },
    });
    for (const n of communities) {
      try {
        await prisma.$transaction([
          prisma.networkMember.create({ data: { networkId: n.id, memberId } }),
          prisma.network.update({
            where: { id: n.id },
            data: { countMember: { increment: 1 } },
          }),
        ]);
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
      }
    }
  }

  private async loginWithPassword(dto: LoginDto): Promise<TokenBundle> {
    if (!dto.username || !dto.password) {
      throw new BadRequestException('username and password required for password grant');
    }

    const username = dto.username.trim().toLowerCase();
    const member = await prisma.member.findFirst({
      where: {
        OR: [{ email: username }, { username: dto.username }, { phone: dto.username }],
      },
    });

    if (!member || !member.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const matches = await this.verifyPassword(dto.password, member);
    if (!matches) throw new UnauthorizedException('Invalid credentials');

    return this.issueTokenBundle(member.id, member.email, normalizeClientType(dto.client_type));
  }

  /**
   * Verify password against bcrypt (new) or legacy hash algos (md5/sha1/sha256).
   * On legacy match, transparently rehashes to bcrypt and updates passwordAlgo.
   * `legacy` is kept as an alias for `md5` for backward compatibility.
   */
  private async verifyPassword(
    plaintext: string,
    member: { id: string; passwordHash: string; passwordAlgo: string },
  ): Promise<boolean> {
    const algo = (member.passwordAlgo ?? '').toLowerCase();

    // Social-only accounts have a random sentinel hash; password grant must
    // never authenticate them.
    if (algo === 'social') return false;

    if (algo === 'bcrypt') {
      return bcrypt.compare(plaintext, member.passwordHash);
    }

    let computed: string | null = null;
    if (algo === 'md5' || algo === 'legacy') {
      computed = createHash('md5').update(plaintext).digest('hex');
    } else if (algo === 'sha1') {
      computed = createHash('sha1').update(plaintext).digest('hex');
    } else if (algo === 'sha256') {
      computed = createHash('sha256').update(plaintext).digest('hex');
    }

    if (computed !== null) {
      if (computed.toLowerCase() !== member.passwordHash.toLowerCase()) return false;
      // Lazy rehash to bcrypt — transparent upgrade on first successful login.
      const newHash = await bcrypt.hash(plaintext, 10);
      await prisma.member.update({
        where: { id: member.id },
        data: { passwordHash: newHash, passwordAlgo: 'bcrypt' },
      });
      return true;
    }

    // Unknown algo — best-effort bcrypt
    return bcrypt.compare(plaintext, member.passwordHash);
  }

  private async loginWithRefreshToken(dto: LoginDto): Promise<TokenBundle> {
    if (!dto.refresh_token) throw new BadRequestException('refresh_token required');

    const payload = verifyRefreshToken(dto.refresh_token);
    const stored = await prisma.refreshToken.findUnique({ where: { token: dto.refresh_token } });
    if (!stored) {
      throw new UnauthorizedException('invalid_refresh_token');
    }
    if (stored.revokedAt) {
      throw new UnauthorizedException('session_revoked');
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('refresh_token_expired');
    }

    const member = await prisma.member.findUnique({ where: { id: payload.sub } });
    if (!member || !member.isActive) throw new UnauthorizedException('Member not active');

    // Rotate the specific row only — refresh must not affect other sessions in
    // the same bucket (web is multi-session) or in the other bucket. Bucket is
    // inherited from the existing row so a stolen refresh can't switch bucket.
    return this.rotateRefreshToken(
      stored.id,
      member.id,
      member.email,
      normalizeClientType(stored.clientType),
    );
  }

  private async loginWithSocial(dto: LoginDto): Promise<TokenBundle> {
    if (dto.provider !== 'google') {
      throw new BadRequestException('Only provider=google is supported');
    }
    if (!dto.social_token) {
      throw new BadRequestException('social_token required for social grant');
    }

    const payload = await this.authenticateViaPassport(dto.social_token);
    if (!payload.emailVerified) {
      throw new UnauthorizedException('google_email_not_verified');
    }

    const clientType = normalizeClientType(dto.client_type);
    const email = payload.email.trim().toLowerCase();

    // Fast path: known google_sub → straight to issue.
    const bySub = await prisma.member.findUnique({ where: { googleSub: payload.sub } });
    if (bySub) {
      if (!bySub.isActive) throw new UnauthorizedException('Member not active');
      return this.issueTokenBundle(bySub.id, bySub.email, clientType);
    }

    // Link path: existing local account by email. Only allow if local account
    // already passed email verification, otherwise an attacker could claim an
    // unverified-registered email by signing in with Google.
    const byEmail = await prisma.member.findUnique({ where: { email } });
    if (byEmail) {
      if (!byEmail.isActive) throw new UnauthorizedException('Member not active');
      if (!byEmail.isVerified) {
        throw new BadRequestException('email_in_use_unverified');
      }
      const linked = await prisma.member.update({
        where: { id: byEmail.id },
        data: { googleSub: payload.sub },
      });
      return this.issueTokenBundle(linked.id, linked.email, clientType);
    }

    // Create path: brand-new social account. Sentinel passwordHash + algo=social
    // so loginWithPassword (verifyPassword guard) can never authenticate it.
    const sentinelHash = `${randomUUID()}${randomUUID()}`;
    const memberCode = await this.generateUniqueMemberCode();
    const username = await this.deriveUniqueUsernameFromEmail(email);

    try {
      const created = await prisma.member.create({
        data: {
          email,
          googleSub: payload.sub,
          fullName: payload.name,
          username,
          passwordHash: sentinelHash,
          passwordAlgo: 'social',
          isVerified: true,
          code: memberCode,
          affiliateCode: memberCode,
          registerFrom: clientType,
        },
      });
      await this.autoJoinCommunityNetworks(created.id);
      return this.issueTokenBundle(created.id, created.email, clientType);
    } catch (err) {
      // Race: a concurrent request created the same email/google_sub first.
      // Re-resolve via the same priority (google_sub then email) and link/issue.
      if (this.isUniqueViolation(err)) {
        const retrySub = await prisma.member.findUnique({ where: { googleSub: payload.sub } });
        if (retrySub) return this.issueTokenBundle(retrySub.id, retrySub.email, clientType);
        const retryEmail = await prisma.member.findUnique({ where: { email } });
        if (retryEmail) {
          if (!retryEmail.isVerified) throw new BadRequestException('email_in_use_unverified');
          const linked = await prisma.member.update({
            where: { id: retryEmail.id },
            data: { googleSub: payload.sub },
          });
          return this.issueTokenBundle(linked.id, linked.email, clientType);
        }
      }
      throw err;
    }
  }

  /**
   * Programmatic Passport invocation: feed `social_token` as a synthetic req
   * body into the registered `google-id-token` strategy and return its payload.
   * Wraps Passport's callback style in a Promise.
   */
  private authenticateViaPassport(idToken: string): Promise<GoogleIdTokenPayload> {
    return new Promise<GoogleIdTokenPayload>((resolve, reject) => {
      const req = { body: { social_token: idToken } } as unknown as Parameters<
        ReturnType<typeof passport.authenticate>
      >[0];
      const res = {} as unknown as Parameters<ReturnType<typeof passport.authenticate>>[1];
      const middleware = passport.authenticate(
        'google-id-token',
        { session: false },
        (err: Error | null, user: GoogleIdTokenPayload | false, info?: { message?: string }) => {
          if (err) return reject(err);
          if (!user)
            return reject(new UnauthorizedException(info?.message ?? 'invalid_google_id_token'));
          resolve(user);
        },
      );
      middleware(req, res, (err: unknown) => {
        if (err) reject(err as Error);
      });
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'P2002'
    );
  }

  private async deriveUniqueUsernameFromEmail(email: string): Promise<string> {
    const local = email.split('@')[0] ?? 'user';
    const base =
      local
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, '')
        .slice(0, 24) || 'user';
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = attempt === 0 ? base : `${base}${randomUUID().slice(0, 6)}`;
      const exists = await prisma.member.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    // Extremely unlikely; fall back to random.
    return `${base}${randomUUID().slice(0, 8)}`;
  }

  async registerDevice(memberId: string, dto: RegisterDeviceDto) {
    const device = await prisma.device.upsert({
      where: { memberId_deviceId: { memberId, deviceId: dto.deviceId } },
      update: {
        platform: dto.platform,
        fcmToken: dto.fcmToken,
        lastSeenAt: new Date(),
      },
      create: {
        memberId,
        deviceId: dto.deviceId,
        platform: dto.platform,
        fcmToken: dto.fcmToken,
      },
    });
    // FE legacy reads `data.data.cloudMessagingId`; emit null cleanly when fcmToken absent.
    return { cloudMessagingId: device.fcmToken, deviceId: device.id };
  }

  async registerCloudMessaging(memberId: string, dto: CloudMessagingDto) {
    const device = dto.deviceId
      ? await prisma.device.findUnique({
          where: { memberId_deviceId: { memberId, deviceId: dto.deviceId } },
        })
      : await prisma.device.findFirst({
          where: { memberId },
          orderBy: { lastSeenAt: 'desc' },
        });
    if (!device) {
      throw new NotFoundException(
        'No device registered for this member — call /auth/devices first',
      );
    }

    await prisma.device.update({
      where: { id: device.id },
      data: { fcmToken: dto.cloudMessagingId, lastSeenAt: new Date() },
    });
    return { cloudMessagingId: dto.cloudMessagingId, deviceId: device.id };
  }

  async requestForgotPassword(dto: RequestForgotPasswordDto) {
    const member = await prisma.member.findUnique({ where: { email: dto.email } });
    if (!member || !member.isActive) {
      throw new NotFoundException('Email not registered');
    }
    const { id } = await otpService.issue({
      target: dto.email,
      purpose: 'forgot-password',
    });
    return { email: dto.email, requestId: id };
  }

  async forgotPasswordVerification(dto: ForgotPasswordVerificationDto) {
    const member = await prisma.member.findUnique({ where: { email: dto.email } });
    if (!member) throw new NotFoundException('Email not registered');

    await otpService.consume(dto.email, dto.code, 'forgot-password');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await prisma.member.update({
      where: { id: member.id },
      data: { passwordHash, passwordAlgo: 'bcrypt' },
    });
    await prisma.refreshToken.updateMany({
      where: { memberId: member.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { email: dto.email };
  }

  async validateOtp(dto: ValidateOtpDto) {
    const purpose = mapDtoPurpose(dto.purpose);
    await otpService.verify(dto.target, dto.code, purpose);
    return { target: dto.target, purpose: dto.purpose };
  }

  // --------------------------------------------------------------------------
  // Phone-register flow (audit #2/#3/#4). FE legacy register-by-phone path.
  // --------------------------------------------------------------------------

  private phoneTarget(phoneCode: string, phone: string): string {
    // Composite key avoids collision between same local-number across dial
    // codes (e.g. +62 8111... vs +1 8111...).
    return `${phoneCode}${phone}`;
  }

  private async resolveMemberByAnyId(input: string) {
    const legacyId = Number.parseInt(input, 10);
    if (Number.isFinite(legacyId) && input === String(legacyId)) {
      const byLegacy = await prisma.member.findUnique({ where: { legacyId } });
      if (byLegacy) return byLegacy;
    }
    assertUuid(input);
    return prisma.member.findUnique({ where: { id: input } });
  }

  async registerByPhone(dto: RegisterByPhoneDto) {
    const target = this.phoneTarget(dto.phoneCode, dto.phone);

    const existing = await prisma.member.findUnique({ where: { phone: dto.phone } });
    if (existing) throw new BadRequestException('Phone already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const memberCode = await this.generateUniqueMemberCode();

    // Member.email is `String @unique` (NOT NULL). Phone-register has no email
    // — synthesize a placeholder so the row is creatable. FE prompts the user
    // to set a real email in the post-OTP profile step. Tracker follow-up:
    // relax email to nullable, or add a separate sentinel column.
    const syntheticEmail = `phone-${dto.phoneCode.replace(/[^0-9]/g, '')}-${dto.phone}@phone.brainboost.local`;

    const member = await prisma.member.create({
      data: {
        email: syntheticEmail,
        passwordHash,
        fullName: dto.name,
        phone: dto.phone,
        phoneCode: dto.phoneCode,
        code: memberCode,
        affiliateCode: memberCode,
        isVerified: false,
        isPhoneVerified: false,
      },
      select: { id: true, legacyId: true, phone: true, phoneCode: true },
    });

    await this.autoJoinCommunityNetworks(member.id);

    const otp = await otpService.issue({ target, purpose: 'verify-phone' });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    logger.info(
      { memberId: member.id, target, otpCode: otp.code },
      'phone-register OTP issued — SMS/WA dispatcher not yet wired',
    );

    return {
      member_id: member.legacyId ?? member.id,
      phone: target,
      expired_date: expiresAt.toISOString(),
    };
  }

  async requestVerificationPhone(dto: RequestVerificationPhoneDto) {
    const member = await this.resolveMemberByAnyId(dto.memberId);
    if (!member) throw new NotFoundException('Member not found');
    if (!member.phone || !member.phoneCode) {
      throw new BadRequestException('Member has no phone on file');
    }
    if (member.isPhoneVerified) {
      throw new BadRequestException('Phone already verified');
    }

    const target = this.phoneTarget(member.phoneCode, member.phone);
    const otp = await otpService.issue({ target, purpose: 'verify-phone' });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    logger.info(
      { memberId: member.id, channel: dto.channel ?? 'sms', target, otpCode: otp.code },
      'verify-phone OTP issued — SMS/WA dispatcher not yet wired',
    );

    return {
      member_id: member.legacyId ?? member.id,
      phone: target,
      expired_date: expiresAt.toISOString(),
    };
  }

  async requestVerifyEmail(memberId: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (member.isVerified) throw new BadRequestException('Email already verified');

    const { code } = await otpService.issue({ target: member.email, purpose: 'verify-email' });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    logger.info({ memberId, email: member.email, otpCode: code }, 'verify-email OTP issued');

    await mailer.send({
      to: member.email,
      subject: 'Verify your email',
      text: `Your verification code is: ${code}. Valid for 10 minutes.`,
      html: `<p>Your verification code is: <strong>${code}</strong></p><p>Valid for 10 minutes.</p>`,
    });

    return { email: member.email, expired_date: expiresAt.toISOString() };
  }

  async verifyEmail(memberId: string, code: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (member.isVerified) throw new BadRequestException('Email already verified');

    await otpService.consume(member.email, code, 'verify-email');

    await prisma.member.update({
      where: { id: memberId },
      data: { isVerified: true },
    });

    return { email: member.email, verified: true };
  }

  async validateOtpPhone(dto: ValidateOtpPhoneDto) {
    const member = await this.resolveMemberByAnyId(dto.memberId);
    if (!member) throw new NotFoundException('Member not found');
    if (!member.phone || !member.phoneCode) {
      throw new BadRequestException('Member has no phone on file');
    }

    const target = this.phoneTarget(member.phoneCode, member.phone);
    await otpService.consume(target, dto.verifyCode, 'verify-phone');

    await prisma.member.update({
      where: { id: member.id },
      data: { isPhoneVerified: true },
    });

    return { member_id: member.legacyId ?? member.id, verified: true };
  }

  private async issueTokenBundle(
    memberId: string,
    email: string,
    clientType: ClientType,
  ): Promise<TokenBundle> {
    const tokenId = randomUUID();
    const accessToken = signAccessToken({ sub: memberId, email, sid: tokenId });
    const refreshToken = signRefreshToken({ sub: memberId, tokenId });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Bucket-scoped single-session:
    //  - mobile login revokes prior live mobile sessions (kicks other phones)
    //  - web login is multi-session (skip revoke; many browsers may coexist)
    // Both run atomically so a concurrent login can't slip a row through.
    const create = prisma.refreshToken.create({
      data: { id: tokenId, memberId, token: refreshToken, expiresAt, clientType },
    });
    if (clientType === 'mobile') {
      await prisma.$transaction([
        prisma.refreshToken.updateMany({
          where: { memberId, clientType: 'mobile', revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        create,
      ]);
    } else {
      await create;
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: parseExpiresInToSeconds(env.jwt.accessExpiresIn),
    };
  }

  /**
   * Per-row rotation on refresh_token grant: revoke the caller's row, mint a
   * new row in the same bucket. Does not touch sibling sessions — mobile
   * kicking is the responsibility of password-grant login, not refresh.
   */
  private async rotateRefreshToken(
    oldTokenId: string,
    memberId: string,
    email: string,
    clientType: ClientType,
  ): Promise<TokenBundle> {
    const tokenId = randomUUID();
    const accessToken = signAccessToken({ sub: memberId, email, sid: tokenId });
    const refreshToken = signRefreshToken({ sub: memberId, tokenId });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: oldTokenId },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: { id: tokenId, memberId, token: refreshToken, expiresAt, clientType },
      }),
    ]);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: parseExpiresInToSeconds(env.jwt.accessExpiresIn),
    };
  }
}
