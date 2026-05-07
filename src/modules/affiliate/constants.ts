// PERFORMANCE tier rates & thresholds (legacy: TBAffiliator::PERFORMANCE_SCHEMA_*)
export const PBS_TIER_RATES = [20, 30, 40] as const;
export const PBS_TIER2_THRESHOLD = 5_000_000; // IDR — naik ke tier 2
export const PBS_TIER3_THRESHOLD = 15_000_000; // IDR — naik ke tier 3

// GROWTH multi-level rates (legacy: TBAffiliator_Commision_CoursePayment::COMMISION_LEVEL_*)
export const GROWTH_LEVEL_RATES = [20, 10, 5, 5] as const; // L1..L4
export const GROWTH_MAX_DEPTH = 4;

// INACTIVE (legacy: TBAffiliator::INACTIVE_COMMISION_PERCENT)
export const INACTIVE_RATE = 20;

// Attribution & status flow
export const COOKIE_DAYS = 30;
export const PENDING_TO_BALANCE_DAYS = 7; // marketing-facing: "5 hari kerja"

// Affiliate modes
export const AFFILIATE_BASED = {
  PERFORMANCE: 'PERFORMANCE',
  GROWTH: 'GROWTH',
  INACTIVE: 'INACTIVE',
} as const;
export type AffiliateBased = (typeof AFFILIATE_BASED)[keyof typeof AFFILIATE_BASED];

// Performance schema labels (snapshot pada Commission)
export const PERFORMANCE_SCHEMA = {
  SCHEMA_1: 'SCHEMA_1',
  SCHEMA_2: 'SCHEMA_2',
  SCHEMA_3: 'SCHEMA_3',
} as const;
export type PerformanceSchema = (typeof PERFORMANCE_SCHEMA)[keyof typeof PERFORMANCE_SCHEMA];

// Commission status
export const COMMISSION_STATUS = {
  PENDING: 'PENDING',
  BALANCE: 'BALANCE',
  VOIDED: 'VOIDED',
} as const;
export type CommissionStatus = (typeof COMMISSION_STATUS)[keyof typeof COMMISSION_STATUS];

// Visit attribution source
export const VISIT_SOURCE = {
  DEEPLINK: 'DEEPLINK',
  WEB: 'WEB',
  INSTALL_REFERRER: 'INSTALL_REFERRER',
  DIRECT: 'DIRECT',
} as const;
export type VisitSource = (typeof VISIT_SOURCE)[keyof typeof VISIT_SOURCE];

// Code format spec (cocok dengan legacy)
export const AFFILIATE_CODE_LENGTH = 6; // Member.affiliateCode
export const PROGRAM_CODE_LENGTH = 8; // AffiliateProgram.code
export const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
