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
export const PENDING_TO_BALANCE_DAYS = 7; // marketing-facing: "5 hari kerja"
// IAP (Apple/Google via RevenueCat) settles monthly; hold longer before allowing payout.
// Runtime-configurable via app_settings key `affiliate.iapHoldDays` (this is the fallback).
export const AFFILIATE_IAP_HOLD_DAYS = 35;
// Channels that route through Apple/Google IAP — apply the longer hold window.
export const IAP_CHANNELS = ['revenuecat'] as const;

// Affiliate attribution cookie (legacy parity: TB_BRAINBOOST_COOKIE, 1-year, last-touch sticky).
// Web flow: set on affiliate-link click, read at checkout. Apps pass affiliateCode explicitly instead.
// Duration is runtime-configurable via app_settings key `affiliate.cookieDays` (this is the fallback).
export const AFFILIATE_COOKIE_NAME = 'bb_aff';
export const AFFILIATE_COOKIE_DAYS_DEFAULT = 365; // 1 year

// Disbursement / payout (legacy: TBDisbursement::affiliate — min 15k, flat fee 5k, net must exceed 10k)
export const DISBURSEMENT_MIN_BALANCE = 15_000; // IDR — minimum withdrawable balance to request
export const DISBURSEMENT_FEE = 5_000; // IDR — flat platform fee per payout
export const DISBURSEMENT_MIN_NET = 10_000; // IDR — net (balance - fee) must be strictly greater than this

// Minimum withdrawable balance required before a member may REQUEST KYC (start a
// verification session / submit manual KYC). Stops nil-balance accounts from
// spamming verifications. Fallback default 0 = gate OFF; the live value lives in
// app_settings `kyc.minBalance` (runtime-overridable, see seed-settings.ts).
export const KYC_MIN_BALANCE_DEFAULT = 0; // IDR

// AUTO-approval cap (legacy TBWithdraw::AMOUNT_MIN_NEED_APPROVAL was 10,000,000).
// We pick a conservative default; runtime-overridable via app_settings
// `disbursement.autoApproveMax`. A payout whose NET exceeds this always goes MANUAL.
export const DISBURSEMENT_AUTO_APPROVE_MAX = 1_000_000; // IDR

// AUTO-approval velocity limits (legacy TBWithdraw::validateStatus: <=1 today, <=3 this week).
export const DISBURSEMENT_AUTO_MAX_PER_DAY = 1;
export const DISBURSEMENT_AUTO_MAX_PER_WEEK = 3;

// Disbursement status
export const DISBURSEMENT_STATUS = {
  PENDING: 'PENDING', // requested, awaiting MANUAL approval (held — counts against balance)
  PROCESSING: 'PROCESSING', // Xendit called, awaiting callback (held — counts against balance)
  PAID: 'PAID', // successfully paid out by provider (held — counts against balance)
  FAILED: 'FAILED', // provider rejected — balance released back
  REJECTED: 'REJECTED', // admin rejected — balance released back
  VOIDED: 'VOIDED', // cancelled — balance released back
} as const;

// Statuses that HOLD (consume) withdrawable balance. Anything NOT here frees it.
// In-flight + paid = held; FAILED / REJECTED / VOIDED = released.
export const DISBURSEMENT_HOLD_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PAID',
] as const;
export type DisbursementStatus = (typeof DISBURSEMENT_STATUS)[keyof typeof DISBURSEMENT_STATUS];

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
  // Legacy commissions imported for lifetime/tier history only. Counts toward
  // lifetimeAmount (status != VOIDED) but NOT withdrawable balance (status != BALANCE)
  // and is never touched by the PENDING->BALANCE cron (status != PENDING).
  MIGRATED: 'MIGRATED',
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
