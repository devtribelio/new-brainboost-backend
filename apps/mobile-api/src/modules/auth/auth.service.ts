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
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@bb/common/exceptions';
import { assertUuid } from '@bb/common/utils/uuid.util';
import { normalizePhonePair, otpPhoneTarget } from '@bb/common/utils/phone.util';
import { isReusableUnverifiedMember } from '@bb/common/utils/member-state.util';
import { otpService } from '@bb/common/services/otp.service';
import type { GoogleIdTokenPayload } from './social/google-verifier';
import { verifyAppleIdentityToken } from './social/apple-verifier';
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
import type { RequestVerificationEmailDto } from './dto/request-verification-email.dto';
import type { ValidateOtpEmailDto } from './dto/validate-otp-email.dto';
import { logger } from '@bb/common/config/logger';
import { VisitService } from '@bb/domain/affiliate/visit.service';

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

  async register(dto: RegisterDto) {
    const conflicts = await prisma.member.findMany({
      where: {
        OR: [
          { email: dto.email },
          dto.phone ? { phone: dto.phone } : undefined,
          dto.username ? { username: dto.username } : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      },
      select: {
        id: true,
        legacyId: true,
        email: true,
        phone: true,
        username: true,
        isActive: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        scheduledDeletionAt: true,
      },
    });

    // Any conflicting row that is NOT a reusable unverified placeholder blocks
    // the register, same precedence as before (email > phone > username).
    for (const row of conflicts) {
      if (isReusableUnverifiedMember(row)) continue;
      if (row.email === dto.email) throw new BadRequestException('Email already registered');
      if (dto.phone && row.phone === dto.phone) {
        throw new BadRequestException('Phone already registered');
      }
      if (dto.username && row.username === dto.username) {
        throw new BadRequestException('Username already registered');
      }
    }

    // All remaining conflicts are reusable placeholders (abandoned-at-OTP
    // registers). Reuse the row holding this email, else the one holding the
    // phone; release the colliding unique fields on any other placeholder so
    // the create/update below can't hit P2002.
    const reuseRow =
      conflicts.find((r) => r.email === dto.email) ??
      conflicts.find((r) => dto.phone && r.phone === dto.phone) ??
      null;
    for (const row of conflicts) {
      if (row.id === reuseRow?.id) continue;
      const release: { phone?: null; username?: null } = {};
      if (dto.phone && row.phone === dto.phone) release.phone = null;
      if (dto.username && row.username === dto.username) release.username = null;
      if (Object.keys(release).length === 0) continue;
      await prisma.member.update({ where: { id: row.id }, data: release });
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

    // Pre-registration carry-over: if this register call didn't carry an
    // affiliate code (e.g. mobile flow that only attached the code at the
    // pre-reg step via deferred deeplink + AppsFlyer), recover it from the
    // PraMember row keyed on email or phone. Without this, `PraMember.
    // affiliateMemberId` is a dead column and post-install attribution from
    // share-the-app links silently breaks at the register boundary.
    // Also capture attributionContext for AffiliateVisit creation below.
    let praAttributionContext: Record<string, string> | null = null;

    if (!inviterId || !inviterNetworkId) {
      const pra = await prisma.praMember.findFirst({
        where: {
          OR: [
            dto.email ? { email: dto.email } : undefined,
            dto.phone ? { phone: dto.phone } : undefined,
          ].filter((c): c is NonNullable<typeof c> => c !== undefined),
        },
        orderBy: { createdAt: 'desc' },
        select: { affiliateMemberId: true, networkId: true, attributionContext: true },
      });
      if (!inviterId && pra?.affiliateMemberId) {
        // Defend against an orphaned id: the inviter must still exist.
        const exists = await prisma.member.findUnique({
          where: { id: pra.affiliateMemberId },
          select: { id: true },
        });
        if (exists) inviterId = exists.id;
      }
      if (!inviterNetworkId && pra?.networkId) inviterNetworkId = pra.networkId;
      if (pra?.attributionContext && typeof pra.attributionContext === 'object') {
        praAttributionContext = pra.attributionContext as Record<string, string>;
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    // Same canonical phone forms as registerByPhone (the DTO even documents
    // E.164 in `phone` — strip the duplicated dial code before storing).
    const normalizedPhone = dto.phone
      ? normalizePhonePair(dto.phone, dto.phoneCode ?? '')
      : null;
    if (normalizedPhone && normalizedPhone.phone.length < 6) {
      throw new BadRequestException('Invalid phone number');
    }

    // Members are born inactive + unverified; the verify-email OTP step
    // (validateOtpEmail) flips isActive=true. Reuse path overwrites the
    // abandoned placeholder in place — code/affiliateCode stay as allocated.
    const memberData = {
      email: dto.email,
      passwordHash,
      passwordAlgo: 'bcrypt',
      fullName: dto.fullName,
      phone: normalizedPhone?.phone ?? dto.phone,
      phoneCode: normalizedPhone ? normalizedPhone.phoneCode || null : dto.phoneCode,
      username: dto.username,
      gender: dto.gender,
      birthdate: dto.birthdate ? new Date(dto.birthdate) : null,
      inviterId,
      utmSource: dto.utmSource,
      utmContent: dto.utmContent,
      isActive: false,
      isEmailVerified: false,
      isPhoneVerified: false,
    };

    let member;
    if (reuseRow) {
      member = await prisma.member.update({
        where: { id: reuseRow.id },
        data: memberData,
      });
    } else {
      const memberCode = await this.generateUniqueMemberCode();
      member = await prisma.member.create({
        data: { ...memberData, code: memberCode, affiliateCode: memberCode },
      });
    }

    if (inviterNetworkId) {
      // create-then-increment inside one transaction; a unique violation means
      // the placeholder already joined on a previous attempt — skip the bump.
      try {
        await prisma.$transaction([
          prisma.networkMember.create({
            data: { networkId: inviterNetworkId, memberId: member.id },
          }),
          prisma.network.update({
            where: { id: inviterNetworkId },
            data: { countMember: { increment: 1 } },
          }),
        ]);
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
      }
    }

    // Best-effort: create AffiliateVisit from pre-registration attribution context.
    // Only runs when inviterId was resolved AND attribution context was stored at
    // pre-registration. Failures are logged but NEVER abort the register flow.
    if (inviterId && praAttributionContext) {
      try {
        const visitService = new VisitService();
        const ctx = praAttributionContext;
        const visitResult = await visitService.createVisitFromRegistration({
          memberId: member.id,
          affiliatorMemberId: inviterId,
          programCode: typeof ctx.programCode === 'string' ? ctx.programCode : undefined,
          utmSource: typeof ctx.utmSource === 'string' ? ctx.utmSource : undefined,
          utmMedium: typeof ctx.utmMedium === 'string' ? ctx.utmMedium : undefined,
          utmCampaign: typeof ctx.utmCampaign === 'string' ? ctx.utmCampaign : undefined,
          utmContent: typeof ctx.utmContent === 'string' ? ctx.utmContent : undefined,
          utmTerm: typeof ctx.utmTerm === 'string' ? ctx.utmTerm : undefined,
          adId: typeof ctx.adId === 'string' ? ctx.adId : undefined,
          adNetwork: typeof ctx.adNetwork === 'string' ? ctx.adNetwork : undefined,
          installReferrer:
            typeof ctx.installReferrer === 'string' ? ctx.installReferrer : undefined,
          deviceId: typeof ctx.deviceId === 'string' ? ctx.deviceId : undefined,
          platform: typeof ctx.platform === 'string' ? ctx.platform : undefined,
          appVersion: typeof ctx.appVersion === 'string' ? ctx.appVersion : undefined,
          // ipAddress and userAgent: AuthService.register receives a DTO with no
          // req headers forwarded. The register controller could thread them in
          // but that's a cross-cutting concern outside the current DTO contract.
          // Leave null here; both fields are nullable on AffiliateVisit.
          ipAddress: null,
          userAgent: null,
        });
        if (visitResult.status !== 'logged') {
          logger.warn(
            { visitStatus: visitResult.status, reason: visitResult.reason, memberId: member.id },
            'affiliate.visit.registration.not_logged',
          );
        }
      } catch (err) {
        logger.warn({ err, memberId: member.id }, 'affiliate.visit.registration.unexpected_error');
      }
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

    // No tokens at register: the member is inactive until the verify-email OTP
    // is validated (validateOtpEmail). FE logs in afterwards.
    const { expiresAt } = await otpService.issue({
      target: dto.email,
      purpose: 'verify-email',
      recipientName: member.fullName ?? undefined,
    });
    logger.info({ memberId: member.id, email: dto.email }, 'register verify-email OTP issued');

    return {
      member_id: member.legacyId ?? member.id,
      email: dto.email,
      expired_date: expiresAt.toISOString(),
    };
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

    const rawUsername = dto.username.trim();
    const username = rawUsername.toLowerCase();
    // Phone-shaped input also matches its canonical stored form, so a user who
    // registered as '8111…' can log in typing '08111…' or '+628111…'. Raw form
    // is kept in the OR for legacy rows stored before normalization.
    const phoneCandidates = /^\+?[0-9]{6,20}$/.test(rawUsername)
      ? [rawUsername, normalizePhonePair(rawUsername, '+62').phone]
      : [];
    const member = await prisma.member.findFirst({
      where: {
        OR: [
          { email: username },
          { username: dto.username },
          ...phoneCandidates.map((phone) => ({ phone })),
        ],
      },
    });

    if (!member) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const matches = await this.verifyPassword(dto.password, member);
    if (!matches) throw new UnauthorizedException('Invalid credentials');

    if (!member.isActive) {
      // Only after the password matched: reveal the unverified state so FE can
      // route to the OTP screen instead of a dead-end credentials error.
      // if (isReusableUnverifiedMember(member)) {
      //   throw new HttpException(403, 'ACCOUNT_NOT_VERIFIED', 'Account not verified', {
      //     member_id: member.legacyId ?? member.id,
      //     phone: member.phone ? this.phoneTarget(member.phoneCode ?? '', member.phone) : null,
      //     email: member.email ?? '',
      //   });
      // }
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokenBundle(
      member.id,
      member.email ?? '',
      normalizeClientType(dto.client_type),
    );
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

    // SECURITY (CodeQL js/insufficient-password-hash false positive): these
    // weak digests are NOT how we store passwords — they only re-derive a
    // member's *existing legacy* hash so we can compare against the value
    // imported from tribelio-platform. On any match we immediately rehash to
    // bcrypt above/below, so the weak algo never survives a successful login.
    let computed: string | null = null;
    if (algo === 'md5' || algo === 'legacy') {
      computed = createHash('md5').update(plaintext).digest('hex'); // lgtm[js/insufficient-password-hash]
    } else if (algo === 'sha1') {
      computed = createHash('sha1').update(plaintext).digest('hex'); // lgtm[js/insufficient-password-hash]
    } else if (algo === 'sha256') {
      computed = createHash('sha256').update(plaintext).digest('hex'); // lgtm[js/insufficient-password-hash]
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
      // NOTE: true RTR reuse-detection (revoke the whole session family when a
      // rotated token is replayed) needs a lineage column (e.g. supersededById)
      // to distinguish a rotation-reuse ATTACK from a token revoked for benign
      // reasons (second login in the single-session bucket, logout, password
      // change). Without it, blanket family-revocation here logs legitimate
      // users out. Tracked as a follow-up (see docs/security-audit-followups.md).
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
      member.email ?? '',
      normalizeClientType(stored.clientType),
    );
  }

  private async loginWithSocial(dto: LoginDto): Promise<TokenBundle> {
    if (!dto.social_token) {
      throw new BadRequestException('social_token required for social grant');
    }

    const clientType = normalizeClientType(dto.client_type);

    if (dto.provider === 'google') {
      const payload = await this.authenticateViaPassport(dto.social_token);
      // Google flow keeps its strict policy: a present-but-unverified email is
      // rejected rather than silently linked.
      if (!payload.emailVerified) {
        throw new UnauthorizedException('google_email_not_verified');
      }
      return this.resolveOrCreateSocialMember({
        provider: 'google',
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        clientType,
        // Affiliate attribution: bound only on first-time signup (create path),
        // never on an already-existing account. Same handling on the Apple path.
        affiliateCode: dto.affiliateCode,
      });
    }

    if (dto.provider === 'apple') {
      const payload = await verifyAppleIdentityToken(dto.social_token);
      // Apple identity is established by token signature + appleSub. Email may be
      // absent (repeat logins) and private-relay addresses arrive with
      // email_verified=true, so we don't hard-block on emailVerified here — the
      // appleSub fast path covers re-logins regardless of email.
      return this.resolveOrCreateSocialMember({
        provider: 'apple',
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        clientType,
        affiliateCode: dto.affiliateCode,
      });
    }

    // facebook etc. not implemented.
    throw new BadRequestException('Unsupported social provider');
  }

  /**
   * Shared resolve-or-create for every social provider. Priority:
   *   1. fast path  — known provider sub → issue.
   *   2. link path  — existing verified local account by email → attach sub.
   *   3. create path— brand-new social account (sentinel hash, algo=social).
   * Falls back to a unique-violation race re-resolve (sub then email).
   *
   * `email` may be null (Apple omits it on repeat logins / nullable column), in
   * which case the email link path is skipped and the member is created with a
   * null email. Provider determines which sub column (`googleSub` | `appleSub`)
   * is read/written throughout.
   */
  private async resolveOrCreateSocialMember(opts: {
    provider: 'google' | 'apple';
    sub: string;
    email: string | null;
    name: string | null;
    clientType: ReturnType<typeof normalizeClientType>;
    // Inviter attribution. Applied ONLY on the create path (new account); every
    // already-exists path leaves inviterId untouched. Passed for both social
    // providers (google + apple).
    affiliateCode?: string;
  }): Promise<TokenBundle> {
    const { provider, sub, name, clientType } = opts;
    const email = opts.email ? opts.email.trim().toLowerCase() : null;
    const subWhere = provider === 'google' ? { googleSub: sub } : { appleSub: sub };
    const subData = provider === 'google' ? { googleSub: sub } : { appleSub: sub };

    // Fast path: known provider sub → straight to issue.
    const bySub = await prisma.member.findUnique({ where: subWhere });
    if (bySub) {
      if (!bySub.isActive) throw new UnauthorizedException('Member not active');
      return this.issueTokenBundle(bySub.id, bySub.email ?? '', clientType);
    }

    // Link path: existing local account by email. Only allow if local account
    // already passed email verification, otherwise an attacker could claim an
    // unverified-registered email by signing in socially. Check verification
    // BEFORE isActive: unverified register placeholders are also inactive, and
    // email_in_use_unverified is the actionable error for them. Skipped entirely
    // when the provider gave us no email (Apple repeat login).
    if (email) {
      const byEmail = await prisma.member.findUnique({ where: { email } });
      if (byEmail) {
        if (!byEmail.isEmailVerified) {
          throw new BadRequestException('email_in_use_unverified');
        }
        if (!byEmail.isActive) throw new UnauthorizedException('Member not active');
        const linked = await prisma.member.update({
          where: { id: byEmail.id },
          data: subData,
        });
        return this.issueTokenBundle(linked.id, linked.email ?? '', clientType);
      }
    }

    // Create path: brand-new social account. Sentinel passwordHash + algo=social
    // so loginWithPassword (verifyPassword guard) can never authenticate it.
    // isEmailVerified:true — the provider attested the identity (Apple-verified even
    // when the email is null / a private relay).
    const sentinelHash = `${randomUUID()}${randomUUID()}`;
    const memberCode = await this.generateUniqueMemberCode();
    const username = await this.deriveUniqueUsernameFromEmail(email ?? `${provider}${sub}`);

    // Bind the inviter ONLY here, on first-time signup. Every already-exists
    // path above returned before reaching this point, so an existing account's
    // inviterId is never written — null stays null, set stays set. Mirrors
    // register(): first 8 chars = inviter member code; a code matching no member
    // is ignored (never aborts signup). Network suffix is not applied here.
    let inviterId: string | undefined;
    if (opts.affiliateCode) {
      const inviter = await prisma.member.findUnique({
        where: { affiliateCode: opts.affiliateCode.slice(0, 8) },
        select: { id: true },
      });
      if (inviter) inviterId = inviter.id;
    }

    try {
      const created = await prisma.member.create({
        data: {
          email,
          ...subData,
          fullName: name,
          username,
          passwordHash: sentinelHash,
          passwordAlgo: 'social',
          isEmailVerified: true,
          code: memberCode,
          affiliateCode: memberCode,
          inviterId,
        },
      });
      await this.autoJoinCommunityNetworks(created.id);
      return this.issueTokenBundle(created.id, created.email ?? '', clientType);
    } catch (err) {
      // Race: a concurrent request created the same email/provider-sub first.
      // Re-resolve via the same priority (provider sub then email) and link/issue.
      if (this.isUniqueViolation(err)) {
        const retrySub = await prisma.member.findUnique({ where: subWhere });
        if (retrySub) return this.issueTokenBundle(retrySub.id, retrySub.email ?? '', clientType);
        if (email) {
          const retryEmail = await prisma.member.findUnique({ where: { email } });
          if (retryEmail) {
            if (!retryEmail.isEmailVerified) throw new BadRequestException('email_in_use_unverified');
            const linked = await prisma.member.update({
              where: { id: retryEmail.id },
              data: subData,
            });
            return this.issueTokenBundle(linked.id, linked.email ?? '', clientType);
          }
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
    // Single active device: enrolling a device on app start makes it THE push
    // target. Clear fcmToken on every OTHER device of this member so a phone that
    // got session-revoked by a newer login (issueTokenBundle single-session kick)
    // stops receiving push. fcm.sendToMember targets by memberId + fcmToken != null,
    // so nulling the token here is what actually severs delivery.
    const [device] = await prisma.$transaction([
      prisma.device.upsert({
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
      }),
      prisma.device.updateMany({
        where: { memberId, deviceId: { not: dto.deviceId }, fcmToken: { not: null } },
        data: { fcmToken: null },
      }),
    ]);
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

    // Same single-active-device rule as registerDevice: token rotation re-asserts
    // this device as THE push target, so drop fcmToken on every other device.
    await prisma.$transaction([
      prisma.device.update({
        where: { id: device.id },
        data: { fcmToken: dto.cloudMessagingId, lastSeenAt: new Date() },
      }),
      prisma.device.updateMany({
        where: { memberId, id: { not: device.id }, fcmToken: { not: null } },
        data: { fcmToken: null },
      }),
    ]);
    return { cloudMessagingId: dto.cloudMessagingId, deviceId: device.id };
  }

  /**
   * Resolve the member + OTP target for the forgot-password pair. email wins
   * when both are supplied; the same rule on both steps keeps issue/consume on
   * one channel. The phone target is rebuilt from the member ROW (canonical),
   * so '0811…' at request and '+62811…' at verification still match.
   */
  private async resolveForgotPasswordMember(dto: { email?: string; phone?: string }) {
    if (dto.email) {
      const member = await prisma.member.findUnique({ where: { email: dto.email } });
      if (!member) return null;
      return { member, target: dto.email, channel: 'email' as const };
    }
    if (dto.phone) {
      const candidates = [dto.phone, normalizePhonePair(dto.phone, '+62').phone];
      const member = await prisma.member.findFirst({
        where: { OR: candidates.map((phone) => ({ phone })) },
      });
      if (!member?.phone) return null;
      return {
        member,
        target: otpPhoneTarget(member.phoneCode ?? '+62', member.phone),
        channel: 'phone' as const,
      };
    }
    throw new BadRequestException('email or phone required');
  }

  async requestForgotPassword(dto: RequestForgotPasswordDto) {
    const resolved = await this.resolveForgotPasswordMember(dto);
    if (!resolved || !resolved.member.isActive) {
      throw new NotFoundException('Account not registered');
    }
    const { member, target, channel } = resolved;
    // WA messages cost per send — cap + resend guard on both channels.
    const { id } = await otpService.issue({
      target,
      purpose: 'forgot-password',
      recipientName: member.fullName ?? undefined,
      maxPerDay: 5,
      enforceResendGuard: true,
    });
    return channel === 'email'
      ? { email: target, requestId: id }
      : { phone: target, requestId: id };
  }

  async forgotPasswordVerification(dto: ForgotPasswordVerificationDto) {
    const resolved = await this.resolveForgotPasswordMember(dto);
    if (!resolved) throw new NotFoundException('Account not registered');
    const { member, target, channel } = resolved;

    await otpService.consume(target, dto.code, 'forgot-password');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await prisma.member.update({
      where: { id: member.id },
      data: { passwordHash, passwordAlgo: 'bcrypt' },
    });
    await prisma.refreshToken.updateMany({
      where: { memberId: member.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return channel === 'email' ? { email: target } : { phone: target };
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
    // codes (e.g. +62 8111... vs +1 8111...). Normalized defensively so rows
    // stored before normalization ('62' / '08111…' / '+628111…') still yield
    // the canonical '+628111…' target — issue and consume both go through here.
    return otpPhoneTarget(phoneCode, phone);
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
    // Canonical forms BEFORE any lookup/store: '08111…' and '8111…' must be
    // the same identity, and phoneCode must be uniform ('62' → '+62').
    const { phone, phoneCode } = normalizePhonePair(dto.phone, dto.phoneCode);
    if (phone.length < 6 || !phoneCode) {
      throw new BadRequestException('Invalid phone number');
    }
    const target = this.phoneTarget(phoneCode, phone);

    const existing = await prisma.member.findUnique({ where: { phone } });
    if (existing && !isReusableUnverifiedMember(existing)) {
      throw new BadRequestException('Phone already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    let member;
    if (existing) {
      // Abandoned-at-OTP placeholder: overwrite in place instead of erroring.
      // Email is kept as-is (real one from an email-register attempt, or NULL
      // from a phone-register); code/affiliateCode stay as allocated.
      member = await prisma.member.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          passwordAlgo: 'bcrypt',
          fullName: dto.name,
          phoneCode,
        },
        select: { id: true, legacyId: true, phone: true, phoneCode: true },
      });
    } else {
      const memberCode = await this.generateUniqueMemberCode();

      // Phone-register collects no email — the row is created with email NULL
      // (FE prompts for a real one in the post-OTP profile step).
      try {
        member = await prisma.member.create({
          data: {
            passwordHash,
            fullName: dto.name,
            phone,
            phoneCode,
            code: memberCode,
            affiliateCode: memberCode,
            isActive: false,
            isEmailVerified: false,
            isPhoneVerified: false,
          },
          select: { id: true, legacyId: true, phone: true, phoneCode: true },
        });
      } catch (err) {
        // Concurrent register with the same phone: the loser of the race hits
        // the unique constraint — surface the same 400 as the up-front check.
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException('Phone already registered');
        }
        throw err;
      }
    }

    await this.autoJoinCommunityNetworks(member.id);

    // Reuse path within the OTP TTL: the previously sent code is still valid
    // on the user's WhatsApp — return its expiry instead of tripping the
    // resend guard (legacy errCode 2113) after the row was already updated.
    if (existing) {
      const activeOtp = await prisma.otpCode.findFirst({
        where: { target, purpose: 'verify-phone', usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (activeOtp) {
        return {
          member_id: member.legacyId ?? member.id,
          phone: target,
          expired_date: activeOtp.expiresAt.toISOString(),
        };
      }
    }

    const { expiresAt } = await otpService.issue({
      target,
      purpose: 'verify-phone',
      recipientName: dto.name,
      maxPerDay: 5,
      enforceResendGuard: true,
    });
    logger.info({ memberId: member.id, target }, 'phone-register OTP issued (WhatsApp)');

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
    const { expiresAt } = await otpService.issue({
      target,
      purpose: 'verify-phone',
      recipientName: member.fullName ?? undefined,
      maxPerDay: 5,
      enforceResendGuard: true,
    });
    logger.info(
      { memberId: member.id, channel: dto.channel ?? 'whatsapp', target },
      'verify-phone OTP issued (WhatsApp)',
    );

    return {
      member_id: member.legacyId ?? member.id,
      phone: target,
      expired_date: expiresAt.toISOString(),
    };
  }

  /**
   * Post-login contact verification, one implementation for both channels.
   * The pre-login pairs (validateOtpPhone/validateOtpEmail) stay separate:
   * different auth model (by memberId, no token) and they carry the
   * isActive=true activation step that must never run here.
   */
  private verifyChannel(
    member: {
      email: string | null;
      phone: string | null;
      phoneCode: string | null;
      isEmailVerified: boolean;
      isPhoneVerified: boolean;
    },
    type: 'email' | 'phone',
  ) {
    if (type === 'email') {
      if (!member.email) throw new BadRequestException('Member has no email on file');
      if (member.isEmailVerified) throw new BadRequestException('Email already verified');
      return {
        target: member.email,
        purpose: 'verify-email' as const,
        flag: { isEmailVerified: true },
      };
    }
    if (!member.phone || !member.phoneCode) {
      throw new BadRequestException('Member has no phone on file');
    }
    if (member.isPhoneVerified) throw new BadRequestException('Phone already verified');
    return {
      target: this.phoneTarget(member.phoneCode, member.phone),
      purpose: 'verify-phone' as const,
      flag: { isPhoneVerified: true },
    };
  }

  async requestVerify(memberId: string, type: 'email' | 'phone') {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    const ch = this.verifyChannel(member, type);

    // Channel (email/WhatsApp) is routed by target shape inside issue().
    const { expiresAt } = await otpService.issue({
      target: ch.target,
      purpose: ch.purpose,
      recipientName: member.fullName ?? undefined,
      maxPerDay: 5,
      enforceResendGuard: true,
    });
    logger.info({ memberId, type, target: ch.target }, 'post-login verify OTP issued');

    return { type, target: ch.target, expired_date: expiresAt.toISOString() };
  }

  async verify(memberId: string, type: 'email' | 'phone', code: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    const ch = this.verifyChannel(member, type);

    await otpService.consume(ch.target, code, ch.purpose);

    await prisma.member.update({
      where: { id: memberId },
      data: ch.flag,
    });

    return { type, target: ch.target, verified: true };
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
      // Activation point of the phone-register flow. Never resurrect an
      // account that is pending deletion (isActive=false for another reason).
      data: {
        isPhoneVerified: true,
        ...(member.scheduledDeletionAt === null ? { isActive: true } : {}),
      },
    });

    return { member_id: member.legacyId ?? member.id, verified: true };
  }

  // --------------------------------------------------------------------------
  // Pre-login email verification (mirror of the phone pair above). Used by the
  // email-register flow: register creates an inactive member, these two
  // endpoints resend/validate the verify-email OTP by memberId — no auth, the
  // member cannot log in yet. The authGuard'd requestVerifyEmail/verifyEmail
  // pair stays for already-logged-in members verifying an email later.
  // --------------------------------------------------------------------------

  async requestVerificationEmail(dto: RequestVerificationEmailDto) {
    const member = await this.resolveMemberByAnyId(dto.memberId);
    if (!member) throw new NotFoundException('Member not found');
    if (!member.email) {
      throw new BadRequestException('Member has no email on file');
    }
    if (member.isEmailVerified) {
      throw new BadRequestException('Email already verified');
    }

    const { expiresAt } = await otpService.issue({
      target: member.email ?? '',
      purpose: 'verify-email',
      recipientName: member.fullName ?? undefined,
    });
    logger.info(
      { memberId: member.id, email: member.email },
      'verify-email OTP issued (pre-login)',
    );

    return {
      member_id: member.legacyId ?? member.id,
      email: member.email ?? '',
      expired_date: expiresAt.toISOString(),
    };
  }

  async validateOtpEmail(dto: ValidateOtpEmailDto) {
    const member = await this.resolveMemberByAnyId(dto.memberId);
    if (!member) throw new NotFoundException('Member not found');
    if (!member.email) {
      throw new BadRequestException('Member has no email on file');
    }

    await otpService.consume(member.email, dto.verifyCode, 'verify-email');

    await prisma.member.update({
      where: { id: member.id },
      // Activation point of the email-register flow. Never resurrect an
      // account that is pending deletion (isActive=false for another reason).
      data: {
        isEmailVerified: true,
        ...(member.scheduledDeletionAt === null ? { isActive: true } : {}),
      },
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
