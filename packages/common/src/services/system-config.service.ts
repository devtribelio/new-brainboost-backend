import { env } from '@bb/common/config/env';

export interface SystemConfigEnvelope {
  appVersion: string;
  minVersionAndroid: string;
  minVersionIos: string;
  maintenance: boolean;
  networkIdHelpDesk: string | null;
  withdrawalFeePercent: number;
  withdrawalMin: number;
  withdrawalMax: number;
  termsAndConditionsUrl: string;
  privacyPolicyUrl: string;
  defaultLanguage: string;
  supportedLanguages: string[];
}

export function buildSystemConfig(): SystemConfigEnvelope {
  return {
    appVersion: process.env.APP_VERSION ?? '1.0.0',
    minVersionAndroid: process.env.MIN_VERSION_ANDROID ?? '1.0.0',
    minVersionIos: process.env.MIN_VERSION_IOS ?? '1.0.0',
    maintenance: (process.env.MAINTENANCE ?? 'false') === 'true',
    networkIdHelpDesk: process.env.NETWORK_ID_HELPDESK || null,
    withdrawalFeePercent: Number.parseFloat(process.env.WITHDRAWAL_FEE_PERCENT ?? '0'),
    withdrawalMin: Number.parseInt(process.env.WITHDRAWAL_MIN ?? '50000', 10),
    withdrawalMax: Number.parseInt(process.env.WITHDRAWAL_MAX ?? '10000000', 10),
    termsAndConditionsUrl: process.env.TNC_URL ?? `${env.baseUrl}/terms`,
    privacyPolicyUrl: process.env.PRIVACY_URL ?? `${env.baseUrl}/privacy`,
    defaultLanguage: process.env.DEFAULT_LANGUAGE ?? 'id',
    supportedLanguages: (process.env.SUPPORTED_LANGUAGES ?? 'id,en').split(','),
  };
}
