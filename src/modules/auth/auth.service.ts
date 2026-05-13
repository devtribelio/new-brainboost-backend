import bcrypt from 'bcryptjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/config/prisma';
import { env } from '@/config/env';
import {
  signAccessToken,
  signAnonAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '@/common/utils/jwt.util';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@/common/exceptions';
import { otpService } from '@/common/services/otp.service';
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
import { logger } from '@/config/logger';

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
        throw new BadRequestException('grant_type "social" not implemented yet');
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

    await prisma.praMember.deleteMany({
      where: {
        OR: [
          dto.email ? { email: dto.email } : undefined,
          dto.phone ? { phone: dto.phone } : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      },
    });

    return this.issueTokenBundle(member.id, member.email);
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

    return this.issueTokenBundle(member.id, member.email);
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

    return this.issueTokenBundle(member.id, member.email);
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

  private async issueTokenBundle(memberId: string, email: string): Promise<TokenBundle> {
    const tokenId = randomUUID();
    const accessToken = signAccessToken({ sub: memberId, email, sid: tokenId });
    const refreshToken = signRefreshToken({ sub: memberId, tokenId });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Single-session: revoke all prior live refresh tokens for this member, then mint.
    // Atomic so a concurrent login can't slip a token between revoke and insert.
    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { memberId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: { id: tokenId, memberId, token: refreshToken, expiresAt },
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
