import { GoogleAuth } from 'google-auth-library';
import { prisma } from '@bb/db';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';

interface FcmPayload {
  title: string;
  body?: string;
  data?: Record<string, string>;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function loadServiceAccount(): ServiceAccountKey | null {
  const raw = env.fcm.serviceAccountJson;
  if (!raw) return null;
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw) as ServiceAccountKey;
    // Treat as file path
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const content = fs.readFileSync(raw, 'utf8');
    return JSON.parse(content) as ServiceAccountKey;
  } catch (err) {
    logger.error({ err }, '[fcm] failed to load service account');
    return null;
  }
}

export class FcmService {
  private auth: GoogleAuth | null = null;
  private projectId: string;
  private enabled: boolean;

  constructor() {
    const account = loadServiceAccount();
    this.projectId = env.fcm.projectId || account?.project_id || '';
    this.enabled = Boolean(account && this.projectId);
    if (this.enabled && account) {
      this.auth = new GoogleAuth({
        credentials: {
          client_email: account.client_email,
          private_key: account.private_key,
        },
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async sendToMember(memberId: string, payload: FcmPayload): Promise<void> {
    if (!this.enabled || !this.auth) return;
    const devices = await prisma.device.findMany({
      where: { memberId, fcmToken: { not: null } },
      select: { id: true, fcmToken: true },
    });
    if (devices.length === 0) return;

    const client = await this.auth.getClient();
    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;

    await Promise.all(
      devices.map(async (d) => {
        if (!d.fcmToken) return;
        try {
          await client.request({
            url,
            method: 'POST',
            data: {
              message: {
                token: d.fcmToken,
                notification: { title: payload.title, body: payload.body ?? '' },
                data: payload.data ?? {},
              },
            },
          });
        } catch (err) {
          await this.handleSendError(d.id, d.fcmToken, err);
        }
      }),
    );
  }

  private async handleSendError(deviceId: string, token: string, err: unknown): Promise<void> {
    const error = err as { response?: { status?: number; data?: unknown }; code?: string };
    const status = error.response?.status;
    const detail = (error.response?.data as { error?: { details?: Array<{ errorCode?: string }> } } | undefined)?.error;
    const errorCode = detail?.details?.[0]?.errorCode;
    const isInvalidToken = status === 404 || errorCode === 'UNREGISTERED' || errorCode === 'INVALID_ARGUMENT';

    if (isInvalidToken) {
      logger.info({ deviceId, errorCode }, '[fcm] invalid token — clearing device fcmToken');
      await prisma.device
        .update({ where: { id: deviceId }, data: { fcmToken: null } })
        .catch((e) => logger.warn({ err: e, deviceId }, '[fcm] failed to clear fcmToken'));
      return;
    }
    logger.warn({ err: error.response?.data ?? error, deviceId }, '[fcm] send failed');
  }
}

export const fcmService = new FcmService();
