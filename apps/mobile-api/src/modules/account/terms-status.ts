import { env } from '@bb/common/config/env';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import type { TermsStatusDto } from './dto/terms-status.dto';

/** Seed / fallback version. A member with `termsVersion` NULL never matches it. */
export const TERMS_VERSION_DEFAULT = '2026-10-01';

/**
 * The single builder of the `terms` block. Profile payload and the acceptTerms
 * response both go through here, so a client can never read two different answers.
 */
export async function buildTermsStatus(member: {
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
}): Promise<TermsStatusDto> {
  const [enabled, currentVersion, url] = await Promise.all([
    settingsService.getBoolean(SETTING_KEYS.termsEnabled, false),
    settingsService.get(SETTING_KEYS.termsCurrentVersion, TERMS_VERSION_DEFAULT),
    settingsService.get(SETTING_KEYS.termsUrl, `${env.baseUrl}/terms`),
  ]);
  return {
    enabled,
    currentVersion,
    url,
    acceptedVersion: member.termsVersion,
    acceptedAt: member.termsAcceptedAt?.toISOString() ?? null,
    needsAcceptance: enabled && member.termsVersion !== currentVersion,
  };
}
