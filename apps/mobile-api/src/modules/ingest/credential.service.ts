import crypto from 'node:crypto';
import { prisma } from '@bb/db';

export interface VerifiedCredential {
  id: string;
  name: string;
  triggersAffiliate: boolean;
  canIngestRefund: boolean;
}

/** API keys are high-entropy random → a fast SHA-256 hash is sufficient (and allows unique-index lookup). */
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export class CredentialService {
  /** Verify a Bearer key → active credential or null. Touches lastUsedAt (best-effort). */
  async verify(key: string | undefined | null): Promise<VerifiedCredential | null> {
    if (!key) return null;
    const cred = await prisma.thirdPartyCredential.findUnique({
      where: { keyHash: hashKey(key) },
      select: { id: true, name: true, isActive: true, triggersAffiliate: true, canIngestRefund: true },
    });
    if (!cred || !cred.isActive) return null;
    void prisma.thirdPartyCredential
      .update({ where: { id: cred.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      id: cred.id,
      name: cred.name,
      triggersAffiliate: cred.triggersAffiliate,
      canIngestRefund: cred.canIngestRefund,
    };
  }

  /**
   * Load an active credential by its `name` (not by key). For trusted in-backend
   * callers that authenticate the request themselves (e.g. the RevenueCat webhook,
   * verified by its own shared-secret guard) and only need the channel's toggles.
   */
  async verifyByName(name: string): Promise<VerifiedCredential | null> {
    const cred = await prisma.thirdPartyCredential.findUnique({
      where: { name },
      select: { id: true, name: true, isActive: true, triggersAffiliate: true, canIngestRefund: true },
    });
    if (!cred || !cred.isActive) return null;
    void prisma.thirdPartyCredential
      .update({ where: { id: cred.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      id: cred.id,
      name: cred.name,
      triggersAffiliate: cred.triggersAffiliate,
      canIngestRefund: cred.canIngestRefund,
    };
  }

  /** Issue a new credential. Returns the PLAINTEXT key ONCE (only the hash is stored). */
  async issue(
    name: string,
    opts?: { triggersAffiliate?: boolean; canIngestRefund?: boolean },
  ): Promise<{ name: string; key: string }> {
    const key = `bbk_${crypto.randomBytes(24).toString('hex')}`;
    await prisma.thirdPartyCredential.create({
      data: {
        name,
        keyHash: hashKey(key),
        triggersAffiliate: opts?.triggersAffiliate ?? false,
        canIngestRefund: opts?.canIngestRefund ?? false,
      },
    });
    return { name, key };
  }

  static hash = hashKey;
}

export const credentialService = new CredentialService();
