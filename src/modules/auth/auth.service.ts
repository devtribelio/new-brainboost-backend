import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/config/prisma';
import { env } from '@/config/env';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '@/common/utils/jwt.util';
import { BadRequestException, UnauthorizedException } from '@/common/exceptions';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: string;
}

export class AuthService {
  async login(dto: LoginDto): Promise<TokenBundle> {
    switch (dto.grant_type) {
      case 'password':
        return this.loginWithPassword(dto);
      case 'refresh_token':
        return this.loginWithRefreshToken(dto);
      case 'social':
      case 'client_credentials':
        throw new BadRequestException(`grant_type "${dto.grant_type}" not implemented yet`);
      default:
        throw new BadRequestException('Unsupported grant_type');
    }
  }

  async register(dto: RegisterDto): Promise<TokenBundle> {
    const existing = await prisma.member.findUnique({ where: { email: dto.email } });
    if (existing) throw new BadRequestException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const member = await prisma.member.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
        phone: dto.phone,
        username: dto.username,
      },
    });

    return this.issueTokenBundle(member.id, member.email);
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
   * Verify password supporting both bcrypt (new) and legacy MD5 (migrated members).
   * On legacy match, transparently rehashes to bcrypt.
   */
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
    // Unknown algo — try bcrypt as best effort
    return bcrypt.compare(plaintext, member.passwordHash);
  }

  private async loginWithRefreshToken(dto: LoginDto): Promise<TokenBundle> {
    if (!dto.refresh_token) throw new BadRequestException('refresh_token required');

    const payload = verifyRefreshToken(dto.refresh_token);
    const stored = await prisma.refreshToken.findUnique({ where: { token: dto.refresh_token } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token revoked or expired');
    }

    const member = await prisma.member.findUnique({ where: { id: payload.sub } });
    if (!member || !member.isActive) throw new UnauthorizedException('Member not active');

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenBundle(member.id, member.email);
  }

  private async issueTokenBundle(memberId: string, email: string): Promise<TokenBundle> {
    const tokenId = randomUUID();
    const accessToken = signAccessToken({ sub: memberId, email });
    const refreshToken = signRefreshToken({ sub: memberId, tokenId });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await prisma.refreshToken.create({
      data: { id: tokenId, memberId, token: refreshToken, expiresAt },
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: env.jwt.accessExpiresIn,
    };
  }
}
