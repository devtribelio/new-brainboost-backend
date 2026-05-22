/**
 * CredentialService — 3rd-party ingestion auth. Requires the app_settings/third_party_credentials
 * tables (migration 20260521170000_ingestion_kernel) on the test DB.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@/config/prisma';
import { credentialService } from '@/modules/ingest/credential.service';

const TAG = `cred-${Date.now()}`;

describe('CredentialService', () => {
  const names: string[] = [];

  afterAll(async () => {
    if (names.length) await prisma.thirdPartyCredential.deleteMany({ where: { name: { in: names } } });
    await prisma.$disconnect();
  });

  it('issue → verify returns the credential with its toggles', async () => {
    const name = `${TAG}-rc`;
    names.push(name);
    const { key } = await credentialService.issue(name, { triggersAffiliate: true });
    const v = await credentialService.verify(key);
    expect(v?.name).toBe(name);
    expect(v?.triggersAffiliate).toBe(true);
    expect(v?.canIngestRefund).toBe(false);
  });

  it('wrong / empty key → null', async () => {
    expect(await credentialService.verify('bbk_does_not_exist')).toBeNull();
    expect(await credentialService.verify('')).toBeNull();
    expect(await credentialService.verify(null)).toBeNull();
  });

  it('inactive credential → null', async () => {
    const name = `${TAG}-off`;
    names.push(name);
    const { key } = await credentialService.issue(name);
    await prisma.thirdPartyCredential.update({ where: { name }, data: { isActive: false } });
    expect(await credentialService.verify(key)).toBeNull();
  });
});
