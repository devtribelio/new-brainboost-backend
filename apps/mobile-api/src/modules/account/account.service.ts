import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { prisma } from '@bb/db';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@bb/common/exceptions';
import { otpService } from '@bb/common/services/otp.service';
import { isReusableUnverifiedMember } from '@bb/common/utils/member-state.util';
import { otpPhoneTarget } from '@bb/common/utils/phone.util';
import type { PreRegistrationDto } from './dto/pre-registration.dto';
import type { LogoutDto } from './dto/logout.dto';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type {
  RequestDeleteAccountDto,
  VerificationDeleteAccountDto,
} from './dto/delete-account.dto';
import type { GetPaymentTokenQueryDto } from './dto/payment-token.dto';

const SCHEDULED_DELETION_DAYS = 15;

export class AccountService {
  /**
   * Bind affiliator code to member (mobile post-login flow).
   * Mirror of legacy `MemberNetworkConnect.findOrCreate` — store inviter linkage
   * once per member. Idempotent: returns existing if already connected, never
   * overwrites once set.
   */
  async affiliateConnect(memberId: string, affiliatorCode: string) {
    if (!affiliatorCode) throw new BadRequestException('affiliatorCode required');

    const me = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, affiliateCode: true, inviterId: true },
    });
    if (!me) throw new NotFoundException('Member not found');

    if (me.affiliateCode && me.affiliateCode === affiliatorCode) {
      throw new BadRequestException('Cannot connect to your own affiliate code');
    }

    const inviter = await prisma.member.findUnique({
      where: { affiliateCode: affiliatorCode },
      select: { id: true, affiliateCode: true, legacyId: true },
    });
    if (!inviter) throw new NotFoundException(`Affiliator code "${affiliatorCode}" not found`);

    // Already connected — return existing without overwriting
    if (me.inviterId) {
      const existingInviter = await prisma.member.findUnique({
        where: { id: me.inviterId },
        select: { id: true, affiliateCode: true, legacyId: true },
      });
      return {
        memberNetworkConnectId: null,
        memberId: me.id,
        affiliatorCode: existingInviter?.affiliateCode ?? null,
        affiliatorMemberId: existingInviter?.legacyId ?? existingInviter?.id ?? null,
        alreadyConnected: true,
      };
    }

    await prisma.member.update({
      where: { id: memberId },
      data: { inviterId: inviter.id },
    });

    return {
      memberNetworkConnectId: null,
      memberId: me.id,
      affiliatorCode: inviter.affiliateCode,
      affiliatorMemberId: inviter.legacyId ?? inviter.id,
      alreadyConnected: false,
    };
  }

  async preRegistration(dto: PreRegistrationDto) {
    if (dto.password !== dto.confirmation) {
      throw new BadRequestException('password and confirmation do not match');
    }

    // Reusable unverified placeholders (abandoned-at-OTP registers) must not
    // block a fresh pre-registration — the register step will reuse their row.
    const existing = await prisma.member.findMany({
      where: {
        OR: [{ email: dto.email }, { phone: dto.phone }],
      },
      select: {
        legacyId: true,
        isActive: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        scheduledDeletionAt: true,
      },
    });
    if (existing.some((m) => !isReusableUnverifiedMember(m))) {
      throw new BadRequestException('Email or phone already registered');
    }

    let affiliateMemberId: string | undefined;
    if (dto.affiliateCode) {
      const inviter = await prisma.member.findUnique({
        where: { affiliateCode: dto.affiliateCode },
      });
      if (inviter) affiliateMemberId = inviter.id;
    }

    // `name` + `phoneCode` + `password` are not yet persisted (PraMember has no
    // columns for them). FE re-sends them on the final register step. Validated
    // here so a bad payload fails fast at the pre-registration boundary.

    // Bundle attribution context if any attribution field was provided. Leave
    // null when none present so behavior is byte-for-byte unchanged for callers
    // that don't send the new fields.
    const attributionContext: Record<string, string> | null = (() => {
      const ctx: Record<string, string> = {};
      if (dto.programCode) ctx.programCode = dto.programCode;
      if (dto.utmSource) ctx.utmSource = dto.utmSource;
      if (dto.utmMedium) ctx.utmMedium = dto.utmMedium;
      if (dto.utmCampaign) ctx.utmCampaign = dto.utmCampaign;
      if (dto.utmContent) ctx.utmContent = dto.utmContent;
      if (dto.utmTerm) ctx.utmTerm = dto.utmTerm;
      if (dto.adId) ctx.adId = dto.adId;
      if (dto.adNetwork) ctx.adNetwork = dto.adNetwork;
      if (dto.installReferrer) ctx.installReferrer = dto.installReferrer;
      if (dto.deviceId) ctx.deviceId = dto.deviceId;
      if (dto.platform) ctx.platform = dto.platform;
      if (dto.appVersion) ctx.appVersion = dto.appVersion;
      return Object.keys(ctx).length > 0 ? ctx : null;
    })();

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await prisma.praMember.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        affiliateMemberId,
        networkId: dto.networkId,
        attributionContext: attributionContext ?? undefined,
        expiresAt,
      },
    });

    await otpService.issue({ target: dto.email, purpose: 'pre-registration' });

    return { email: dto.email, phone: dto.phone };
  }

  async logout(memberId: string, dto: LogoutDto) {
    if (dto.refresh_token) {
      await prisma.refreshToken.updateMany({
        where: { token: dto.refresh_token, memberId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      await prisma.refreshToken.updateMany({
        where: { memberId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    if (dto.cloudMessagingId) {
      await prisma.device.updateMany({
        where: { memberId, fcmToken: dto.cloudMessagingId },
        data: { fcmToken: null },
      });
    } else {
      await prisma.device.updateMany({
        where: { memberId },
        data: { fcmToken: null },
      });
    }

    return { loggedOut: true, logoutFrom: null };
  }

  async changePassword(memberId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmNewPassword) {
      throw new BadRequestException('newPassword and confirmNewPassword do not match');
    }

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.isActive) throw new UnauthorizedException('Member is not active');

    const matches = await this.verifyPassword(dto.oldPassword, member);
    if (!matches) throw new BadRequestException('Old password is incorrect');

    if (dto.oldPassword === dto.newPassword) {
      throw new BadRequestException('New password must differ from old password');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    const updated = await prisma.member.update({
      where: { id: memberId },
      data: { passwordHash, passwordAlgo: 'bcrypt' },
      select: {
        id: true,
        legacyId: true,
        email: true,
        username: true,
        phone: true,
        fullName: true,
        avatarUrl: true,
        code: true,
      },
    });

    // SECURITY: a password change must evict any other (possibly compromised)
    // session. Without this, a stolen refresh token keeps minting access tokens
    // indefinitely after the victim changes their password. Mirrors the
    // forgot-password resetPassword + logout revoke-all behaviour.
    await prisma.refreshToken.updateMany({
      where: { memberId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return updated;
  }

  async getPaymentToken(query: GetPaymentTokenQueryDto) {
    return {
      id: query.id ?? null,
      type: query.type ?? null,
      paymentStatus: null,
      virtualAccountNumber: null,
      bank: null,
      expiredDate: null,
      paymentType: null,
      paymentAmount: null,
      qrCheckoutString: null,
      vendorCheckoutUrl: null,
      vendorCheckoutDeeplinkUrl: null,
      typeEwallet: null,
      emoneyType: null,
      paylater: null,
      externalId: null,
      phonePayment: null,
      address: null,
    };
  }

  /**
   * Where the delete-account OTP goes: email when the member has one,
   * otherwise their phone (WhatsApp) — phone-registered members have email
   * NULL. otpService routes channel by target shape ('@' → email).
   */
  private deleteAccountOtpTarget(member: {
    email: string | null;
    phone: string | null;
    phoneCode: string | null;
  }): string {
    if (member.email) return member.email;
    if (member.phone && member.phoneCode) return otpPhoneTarget(member.phoneCode, member.phone);
    throw new BadRequestException('Member has no email or phone on file');
  }

  async requestDeleteAccount(memberId: string, dto: RequestDeleteAccountDto) {
    if (dto.agree === false) {
      throw new BadRequestException('Confirmation required to proceed');
    }
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');

    await otpService.issue({
      target: this.deleteAccountOtpTarget(member),
      purpose: 'delete-account',
      recipientName: member.fullName ?? undefined,
    });
    return { memberId };
  }

  async verificationDeleteAccount(memberId: string, dto: VerificationDeleteAccountDto) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');

    await otpService.consume(this.deleteAccountOtpTarget(member), dto.otpCode, 'delete-account');

    const scheduledDeletionAt = new Date(
      Date.now() + SCHEDULED_DELETION_DAYS * 24 * 60 * 60 * 1000,
    );
    await prisma.member.update({
      where: { id: memberId },
      data: { scheduledDeletionAt, isActive: false },
    });
    await prisma.refreshToken.updateMany({
      where: { memberId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { memberId, scheduledDeletionAt };
  }

  async recoverAccountScheduled(memberId: string) {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found');
    if (!member.scheduledDeletionAt) {
      throw new BadRequestException('Account is not scheduled for deletion');
    }

    await prisma.member.update({
      where: { id: memberId },
      data: { scheduledDeletionAt: null, isActive: true },
    });
    return { memberId, recovered: true };
  }

  private async verifyPassword(
    plaintext: string,
    member: { id: string; passwordHash: string; passwordAlgo: string },
  ): Promise<boolean> {
    if (member.passwordAlgo === 'bcrypt') {
      return bcrypt.compare(plaintext, member.passwordHash);
    }
    if (member.passwordAlgo === 'legacy') {
      const md5 = createHash('md5').update(plaintext).digest('hex');
      if (md5 !== member.passwordHash) return false;
      const newHash = await bcrypt.hash(plaintext, 10);
      await prisma.member.update({
        where: { id: member.id },
        data: { passwordHash: newHash, passwordAlgo: 'bcrypt' },
      });
      return true;
    }
    return bcrypt.compare(plaintext, member.passwordHash);
  }
}
