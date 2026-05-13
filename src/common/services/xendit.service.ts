import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';

export type XenditPaymentType = 'cc' | 'va' | 'eWallet';

export interface XenditCardChargeOptions {
  tokenId: string;
  amount: number;
  externalId: string;
  authenticationId?: string;
}

export interface XenditCardChargeResult {
  id: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  failureReason?: string;
  cardBrand?: string;
  maskedCardNumber?: string;
  chargeType?: string;
  raw: unknown;
}

export interface XenditVaOptions {
  bank: string;
  amount: number;
  externalId: string;
  expiredAt: Date;
  memberId: string;
}

export interface XenditVaResult {
  id: string;
  accountNumber: string;
  expirationDate: string;
  raw: unknown;
}

export interface XenditEwalletOptions {
  ewalletType: string;
  phone?: string;
  amount: number;
  externalId: string;
  expiredAt: Date;
}

export interface XenditEwalletResult {
  id: string;
  checkoutUrl?: string;
  qrString?: string;
  raw: unknown;
}

const COMMERCE_PREFIX = 'commerce';

export class XenditService {
  generateExternalId(prefix = COMMERCE_PREFIX): string {
    return `${prefix}-${randomUUID()}`;
  }

  verifyCallbackToken(headerValue: string | undefined): boolean {
    const expected = env.xendit.callbackToken;
    if (!expected || !headerValue) return false;
    const a = Buffer.from(headerValue);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async createCardCharge(_opts: XenditCardChargeOptions): Promise<XenditCardChargeResult> {
    this.assertConfigured();
    logger.warn('[xendit] createCardCharge not yet implemented');
    throw new Error('XenditService.createCardCharge not implemented (P3)');
  }

  async createCallbackVa(_opts: XenditVaOptions): Promise<XenditVaResult> {
    this.assertConfigured();
    logger.warn('[xendit] createCallbackVa not yet implemented');
    throw new Error('XenditService.createCallbackVa not implemented (P3)');
  }

  async cancelVa(_vaId: string): Promise<void> {
    this.assertConfigured();
    throw new Error('XenditService.cancelVa not implemented (P3)');
  }

  async getVa(_vaId: string): Promise<{ status: string; raw: unknown }> {
    this.assertConfigured();
    throw new Error('XenditService.getVa not implemented (P3)');
  }

  async createEwalletCharge(_opts: XenditEwalletOptions): Promise<XenditEwalletResult> {
    this.assertConfigured();
    logger.warn('[xendit] createEwalletCharge not yet implemented');
    throw new Error('XenditService.createEwalletCharge not implemented (P3)');
  }

  private assertConfigured(): void {
    if (!env.xendit.secretKey) {
      throw new Error('XENDIT_SECRET_KEY not configured');
    }
  }
}

export const xenditService = new XenditService();
