import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { isValidPhone, toMsisdn } from '@bb/common/utils/phone.util';

/**
 * Qontak WhatsApp Business sender. Ports the delivery half of legacy
 * `TBQontak` / `TBQontak_Queue::send`:
 *   - OAuth2 password grant against `{baseUrl}/oauth/token`
 *   - template broadcast against `{baseUrl}/api/open/v1/broadcasts/whatsapp/direct`
 *
 * When Qontak credentials are not configured the service degrades to a no-op
 * that logs the would-be message (same pattern as `mailer`), so dev/test boot
 * without a live Qontak account and OTP codes still surface in the logs.
 */

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export interface WhatsAppTemplateParams {
  /** Ordered values for the template body placeholders ({{1}}, {{2}}, …). */
  body: string[];
  /** Optional URL-button dynamic suffix (legacy `buttonData['url']`). */
  buttonUrlValue?: string;
}

class WhatsAppService {
  private cachedToken: CachedToken | null = null;

  private isConfigured(): boolean {
    const q = env.qontak;
    return Boolean(q.clientId && q.clientSecret && q.username && q.password);
  }

  /** Digits-only form Qontak expects (e.g. 62812...), via E.164 normalize. */
  private normalizePhone(raw: string): string {
    return toMsisdn(raw);
  }

  private async getToken(): Promise<string | null> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now() + 30_000) {
      return this.cachedToken.token;
    }

    const q = env.qontak;
    const res = await fetch(`${q.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: q.clientId,
        client_secret: q.clientSecret,
        username: q.username,
        password: q.password,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error({ status: res.status, body: text }, '[whatsapp] Qontak token request failed');
      return null;
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      logger.error({ json }, '[whatsapp] Qontak token response missing access_token');
      return null;
    }

    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.cachedToken = { token: json.access_token, expiresAtMs: Date.now() + ttlMs };
    return json.access_token;
  }

  /**
   * Send a WhatsApp template message. Returns true on success, false on any
   * failure or when Qontak is not configured (fire-and-forget friendly).
   */
  async sendTemplate(input: {
    to: string;
    toName: string;
    templateId: string;
    channelIntegrationId: string;
    params: WhatsAppTemplateParams;
    languageCode?: string;
  }): Promise<boolean> {
    if (!isValidPhone(input.to)) {
      logger.warn({ to: input.to }, '[whatsapp] invalid phone number — not sending');
      return false;
    }

    const phone = this.normalizePhone(input.to);

    if (!this.isConfigured()) {
      logger.warn(
        { to: phone, templateId: input.templateId, body: input.params.body },
        '[whatsapp] Qontak not configured — printing message instead of sending',
      );
      return false;
    }

    const token = await this.getToken();
    if (!token) return false;

    const body = input.params.body.map((value, idx) => ({
      key: String(idx + 1),
      value: String(idx + 1),
      value_text: value,
    }));

    const buttons =
      input.params.buttonUrlValue !== undefined
        ? [{ index: '0', type: 'URL', value: input.params.buttonUrlValue }]
        : undefined;

    const res = await fetch(`${env.qontak.baseUrl}/api/open/v1/broadcasts/whatsapp/direct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to_number: phone,
        to_name: input.toName,
        message_template_id: input.templateId,
        channel_integration_id: input.channelIntegrationId,
        language: { code: input.languageCode ?? 'id' },
        parameters: { body, ...(buttons ? { buttons } : {}) },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: text, to: phone },
        '[whatsapp] Qontak broadcast failed',
      );
      return false;
    }

    logger.info({ to: phone, templateId: input.templateId }, '[whatsapp] Qontak message sent');
    return true;
  }

  /**
   * Convenience for the OTP template (legacy
   * MemberVerificationOtpPhoneNumber): single body var + URL button, both the
   * OTP code.
   */
  async sendOtp(phone: string, name: string, code: string): Promise<boolean> {
    return this.sendTemplate({
      to: phone,
      toName: name || 'Member',
      templateId: env.qontak.otpTemplateId,
      channelIntegrationId: env.qontak.channelIntegrationId,
      params: { body: [code], buttonUrlValue: code },
    });
  }
}

export const whatsappService = new WhatsAppService();
