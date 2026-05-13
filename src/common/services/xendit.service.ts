import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { randomUUID, timingSafeEqual } from 'node:crypto';

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
  memberName: string;
}

export interface XenditVaResult {
  id: string;
  accountNumber: string;
  expirationDate: string;
  raw: unknown;
}

export interface XenditEwalletOptions {
  ewalletType: string; // OVO / DANA / LINKAJA / GOPAY / SHOPEEPAY
  phone?: string;
  amount: number;
  externalId: string;
  expiredAt: Date;
}

export interface XenditEwalletResult {
  id: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  checkoutUrl?: string;
  deeplinkUrl?: string;
  qrString?: string;
  raw: unknown;
}

export interface XenditCancelVaResult {
  id: string;
  status: string;
}

export interface IXenditService {
  generateExternalId(prefix?: string): string;
  verifyCallbackToken(headerValue: string | undefined): boolean;
  createCardCharge(opts: XenditCardChargeOptions): Promise<XenditCardChargeResult>;
  createCallbackVa(opts: XenditVaOptions): Promise<XenditVaResult>;
  cancelVa(vaId: string): Promise<XenditCancelVaResult>;
  getVa(vaId: string): Promise<{ status: string; raw: unknown }>;
  createEwalletCharge(opts: XenditEwalletOptions): Promise<XenditEwalletResult>;
}

const COMMERCE_PREFIX = 'commerce';

const EWALLET_CHANNEL_CODE: Record<string, string> = {
  OVO: 'ID_OVO',
  DANA: 'ID_DANA',
  LINKAJA: 'ID_LINKAJA',
  GOPAY: 'ID_GOPAY',
  SHOPEEPAY: 'ID_SHOPEEPAY',
};

export class XenditService implements IXenditService {
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

  async createCardCharge(opts: XenditCardChargeOptions): Promise<XenditCardChargeResult> {
    const body: Record<string, unknown> = {
      token_id: opts.tokenId,
      external_id: opts.externalId,
      amount: opts.amount,
    };
    if (opts.authenticationId) body.authentication_id = opts.authenticationId;
    const res = await this.request<Record<string, unknown>>('POST', '/credit_card_charges', body);
    const rawStatus = String(res.status ?? '').toUpperCase();
    const status: 'SUCCESS' | 'FAILED' | 'PENDING' =
      rawStatus === 'CAPTURED' || rawStatus === 'AUTHORIZED' || rawStatus === 'SUCCESS'
        ? 'SUCCESS'
        : rawStatus === 'FAILED'
          ? 'FAILED'
          : 'PENDING';
    return {
      id: String(res.id ?? ''),
      status,
      failureReason: (res.failure_reason as string) ?? undefined,
      cardBrand: (res.card_brand as string) ?? undefined,
      maskedCardNumber: (res.masked_card_number as string) ?? undefined,
      chargeType: (res.charge_type as string) ?? undefined,
      raw: res,
    };
  }

  async createCallbackVa(opts: XenditVaOptions): Promise<XenditVaResult> {
    const body = {
      external_id: opts.externalId,
      bank_code: opts.bank,
      name: opts.memberName,
      expected_amount: opts.amount,
      is_closed: true,
      is_single_use: true,
      expiration_date: opts.expiredAt.toISOString(),
    };
    const res = await this.request<Record<string, unknown>>(
      'POST',
      '/callback_virtual_accounts',
      body,
    );
    return {
      id: String(res.id ?? ''),
      accountNumber: String(res.account_number ?? ''),
      expirationDate: String(res.expiration_date ?? ''),
      raw: res,
    };
  }

  async cancelVa(vaId: string): Promise<XenditCancelVaResult> {
    const res = await this.request<Record<string, unknown>>(
      'PATCH',
      `/callback_virtual_accounts/${vaId}`,
      { is_single_use: true, expected_amount: 0, expiration_date: new Date().toISOString() },
    );
    return { id: String(res.id ?? vaId), status: String(res.status ?? '') };
  }

  async getVa(vaId: string): Promise<{ status: string; raw: unknown }> {
    const res = await this.request<Record<string, unknown>>(
      'GET',
      `/callback_virtual_accounts/${vaId}`,
    );
    return { status: String(res.status ?? ''), raw: res };
  }

  async createEwalletCharge(opts: XenditEwalletOptions): Promise<XenditEwalletResult> {
    const channel = EWALLET_CHANNEL_CODE[opts.ewalletType.toUpperCase()];
    if (!channel) throw new Error(`Unsupported eWallet type: ${opts.ewalletType}`);
    const body: Record<string, unknown> = {
      reference_id: opts.externalId,
      currency: 'IDR',
      amount: opts.amount,
      checkout_method: 'ONE_TIME_PAYMENT',
      channel_code: channel,
      channel_properties: opts.phone ? { mobile_number: opts.phone } : {},
    };
    const res = await this.request<Record<string, unknown>>('POST', '/ewallets/charges', body);
    const actions = (res.actions as Record<string, unknown> | undefined) ?? {};
    const rawStatus = String(res.status ?? '').toUpperCase();
    const status: 'PENDING' | 'SUCCESS' | 'FAILED' =
      rawStatus === 'SUCCEEDED' || rawStatus === 'COMPLETED' || rawStatus === 'PAID'
        ? 'SUCCESS'
        : rawStatus === 'FAILED'
          ? 'FAILED'
          : 'PENDING';
    return {
      id: String(res.id ?? ''),
      status,
      checkoutUrl:
        (actions.mobile_web_checkout_url as string) ??
        (actions.desktop_web_checkout_url as string) ??
        undefined,
      deeplinkUrl: (actions.mobile_deeplink_checkout_url as string) ?? undefined,
      qrString: (actions.qr_checkout_string as string) ?? undefined,
      raw: res,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!env.xendit.secretKey) {
      throw new Error('XENDIT_SECRET_KEY not configured');
    }
    const url = `${env.xendit.baseUrl}${path}`;
    const authHeader = `Basic ${Buffer.from(`${env.xendit.secretKey}:`).toString('base64')}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const errBody = json as { error_code?: string; message?: string };
      const msg = errBody.message ?? errBody.error_code ?? `HTTP ${res.status}`;
      logger.error({ url, status: res.status, body: json }, '[xendit] request failed');
      const e = new Error(`Xendit ${method} ${path} failed: ${msg}`) as Error & {
        errorCode?: string;
        status?: number;
        body?: unknown;
      };
      e.errorCode = errBody.error_code;
      e.status = res.status;
      e.body = json;
      throw e;
    }
    return json as T;
  }
}

export const xenditService: IXenditService = new XenditService();
