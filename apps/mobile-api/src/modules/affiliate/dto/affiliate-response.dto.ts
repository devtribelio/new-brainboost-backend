import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

const AFFILIATE_BASED_ENUM = ['PERFORMANCE', 'GROWTH', 'INACTIVE'] as const;
const COMMISSION_STATUS_ENUM = ['PENDING', 'BALANCE', 'VOIDED'] as const;

/** `GET /affiliate/me` — affiliator profile. */
export class AffiliatorProfileDto {
  @ApiProperty({ format: 'uuid' })
  memberId!: string;

  @ApiProperty({ example: 'X7K9Q2', description: 'Personal affiliate code (6 chars). Auto-generated if missing.' })
  affiliateCode!: string;

  @ApiProperty({ enum: AFFILIATE_BASED_ENUM, example: 'PERFORMANCE' })
  affiliateBased!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', description: 'Member who invited this affiliator.' })
  inviterId?: string | null;
}

/** `POST /affiliate/me/mode` — mode change result. */
export class SetModeResultDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: AFFILIATE_BASED_ENUM, example: 'PERFORMANCE' })
  affiliateBased!: string;
}

/** Recent commission entry embedded in the affiliator summary (merged legacy commisionSummary). */
export class AffiliatorSummaryRecentEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: 'integer', example: 500_000 })
  amount!: number;

  @ApiProperty({ enum: COMMISSION_STATUS_ENUM, example: 'PENDING' })
  status!: string;

  @ApiPropertyOptional({ nullable: true, example: 'DEEPLINK', description: 'Origin of the commission entry.' })
  source?: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-05-10T00:00:00.000Z' })
  createdAt!: string;
}

/** `GET /affiliate/me/summary` — affiliator dashboard aggregate. */
export class AffiliatorSummaryDto {
  @ApiProperty({ type: 'integer', example: 7_500_000, description: 'Lifetime commission, excludes VOIDED + INACTIVE.' })
  lifetimeAmount!: number;

  @ApiProperty({ type: 'integer', example: 2_000_000, description: 'Withdrawable balance.' })
  balance!: number;

  @ApiProperty({ type: 'integer', example: 500_000, description: 'Pending — moves to balance 7 days after payment.' })
  pending!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  voided!: number;

  @ApiProperty({ example: 'IDR' })
  currency!: string;

  @ApiProperty({ type: 'integer', example: 2, description: 'PERFORMANCE tier (1/2/3).' })
  currentTier!: number;

  @ApiProperty({ type: 'integer', example: 30, description: 'Current commission rate (%).' })
  currentRate!: number;

  @ApiPropertyOptional({ nullable: true, example: 'SCHEMA_2', enum: ['SCHEMA_1', 'SCHEMA_2', 'SCHEMA_3'] })
  schemaType?: string | null;

  // --- Merged legacy commisionSummary fields (FE legacy CommisionModel — typos preserved) ---
  @ApiProperty({
    type: 'integer',
    example: 5_000_000,
    description: 'Sum of PENDING + BALANCE commission amounts (incl INACTIVE). FE legacy `totalSales`.',
  })
  totalCommision!: number;

  @ApiProperty({
    type: 'integer',
    example: 25_000_000,
    description: 'Sum of productPrice across PENDING + BALANCE commissions (gross transaction sales).',
  })
  totalTransactionSales!: number;

  @ApiProperty({ type: 'integer', example: 5_000_000, description: 'Modern alias of `totalCommision`.' })
  total!: number;

  @ApiProperty({ type: 'integer', example: 12, description: 'Count of PENDING + BALANCE commission rows.' })
  count!: number;

  @ApiProperty({
    type: 'array',
    itemType: () => AffiliatorSummaryRecentEntryDto,
    description: 'Up to 10 most recent commission entries (all statuses).',
  })
  recent!: AffiliatorSummaryRecentEntryDto[];
}

/** Program summary embedded in a commission row. */
export class AffiliateCommissionProgramDto {
  @ApiProperty({ example: 'AB12CD34' })
  code!: string;

  @ApiProperty({ example: 'Course Launch 2026' })
  name!: string;
}

/** `GET /affiliate/me/commissions` — one commission ledger row. */
export class AffiliateCommissionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: 'integer' })
  legacyId?: number | null;

  @ApiProperty({ format: 'uuid' })
  recipientId!: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', description: 'MemberAffiliator id (program membership).' })
  affiliatorId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  programId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  productId?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  paymentId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: 'integer' })
  paymentLegacyId?: number | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  buyerMemberId?: string | null;

  @ApiProperty({ type: 'integer', example: 1, description: 'Inviter-chain depth (GROWTH up to 4).' })
  level!: number;

  @ApiProperty({ enum: AFFILIATE_BASED_ENUM, example: 'PERFORMANCE', description: 'Recipient mode snapshot at commit time.' })
  affiliateBased!: string;

  @ApiPropertyOptional({ nullable: true, enum: ['SCHEMA_1', 'SCHEMA_2', 'SCHEMA_3'] })
  schemaType?: string | null;

  @ApiProperty({ type: 'integer', example: 500_000 })
  productPrice!: number;

  @ApiProperty({ type: 'integer', example: 50_000 })
  voucherAmount!: number;

  @ApiProperty({ type: 'integer', example: 30, description: 'Commission rate applied (%).' })
  commissionRate!: number;

  @ApiProperty({ type: 'integer', example: 135_000, description: 'priceRecipient — computed payout.' })
  amount!: number;

  @ApiProperty({ enum: COMMISSION_STATUS_ENUM, example: 'PENDING' })
  status!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  approvedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  voidedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  voidedBy?: string | null;

  @ApiPropertyOptional({ nullable: true })
  voidedReason?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: ['DEEPLINK', 'WEB', 'INSTALL_REFERRER'] })
  source?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  attributionVisitId?: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiPropertyOptional({ nullable: true, type: () => AffiliateCommissionProgramDto })
  program?: AffiliateCommissionProgramDto | null;
}

/** `GET /affiliate/programs` — one active program. */
export class AffiliateProgramDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: 'integer' })
  legacyId?: number | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  productId?: string | null;

  @ApiProperty({ example: 'AB12CD34', description: 'Program code (8 chars).' })
  code!: string;

  @ApiProperty({ example: 'Course Launch 2026' })
  name!: string;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiPropertyOptional({ nullable: true, type: 'object', description: 'Linked product, when the program targets one.' })
  product?: Record<string, unknown> | null;
}

/** `POST /affiliate/programs/:code/enroll` — program membership. */
export class MemberAffiliatorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: 'integer' })
  legacyId?: number | null;

  @ApiProperty({ format: 'uuid' })
  memberId!: string;

  @ApiProperty({ format: 'uuid' })
  programId!: string;

  @ApiPropertyOptional({ nullable: true, example: 'LEAVE' })
  exitState?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  exitAt?: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

const DISBURSEMENT_STATUS_ENUM = [
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'REJECTED',
  'VOIDED',
] as const;

/** One affiliate payout request. */
export class AffiliateDisbursementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  memberId!: string;

  @ApiProperty({ type: 'integer', example: 50_000, description: 'Withdrawable balance consumed.' })
  grossAmount!: number;

  @ApiProperty({ type: 'integer', example: 5_000 })
  fee!: number;

  @ApiProperty({ type: 'integer', example: 45_000, description: 'Paid to member = gross - fee.' })
  netAmount!: number;

  @ApiProperty({ enum: DISBURSEMENT_STATUS_ENUM, example: 'PENDING' })
  status!: string;

  @ApiPropertyOptional({ nullable: true, enum: ['AUTO', 'MANUAL'], example: 'MANUAL', description: 'How this payout was routed.' })
  mode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'BCA' })
  bankCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1234567890' })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'BUDI SANTOSO' })
  bankAccountName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'xendit' })
  provider?: string | null;

  @ApiPropertyOptional({ nullable: true })
  providerRef?: string | null;

  @ApiPropertyOptional({ nullable: true })
  failureReason?: string | null;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  paidAt?: string | null;
}

/** `GET /affiliate/me/disbursement` — withdrawable balance + eligibility. */
export class DisbursementSummaryDto {
  @ApiProperty({ type: 'integer', example: 50_000 })
  withdrawableBalance!: number;

  @ApiProperty({ example: true, description: 'True only if balance meets thresholds AND no pending payout exists.' })
  eligible!: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Why not eligible, when applicable.' })
  reason?: string | null;

  @ApiProperty({ type: 'integer', example: 5_000 })
  fee!: number;

  @ApiProperty({ type: 'integer', example: 45_000, description: 'Projected net payout = balance - fee.' })
  netAmount!: number;

  @ApiProperty({ enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'], example: 'APPROVED' })
  kycStatus!: string;

  @ApiProperty({ example: true, description: 'True when bankCode + number + name are all set.' })
  hasBankAccount!: boolean;

  @ApiProperty({ example: false })
  hasPendingDisbursement!: boolean;

  @ApiPropertyOptional({ nullable: true, type: () => AffiliateDisbursementDto })
  pendingDisbursement?: AffiliateDisbursementDto | null;
}

/** `GET`/`PUT /affiliate/me/bank-account` — payout bank account. */
export class BankAccountDto {
  @ApiPropertyOptional({ nullable: true, example: 'BCA' })
  bankCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1234567890' })
  bankAccountNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'BUDI SANTOSO' })
  bankAccountName?: string | null;
}

/** `GET`/`POST /affiliate/me/kyc` — manual KYC status + submitted fields. */
export class KycDto {
  @ApiProperty({ enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'], example: 'PENDING' })
  kycStatus!: string;

  @ApiPropertyOptional({ nullable: true, example: '3201010101010001' })
  kycIdNumber?: string | null;

  @ApiPropertyOptional({ nullable: true })
  kycIdCardUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  kycSelfieUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  kycSubmittedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  kycReviewedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Reason when kycStatus is REJECTED.' })
  kycRejectedReason?: string | null;

  @ApiProperty({
    type: 'integer',
    example: 55000,
    description:
      'Minimum withdrawable balance (IDR) required to request KYC (app_settings kyc.minBalance). 0 = gate off.',
  })
  kycMinBalance!: number;

  @ApiProperty({
    example: false,
    description:
      'Whether the member may start a KYC request now: kycStatus !== APPROVED AND withdrawableBalance >= kycMinBalance.',
  })
  isEligible!: boolean;
}

/** `POST /affiliate/me/kyc/token` — Didit verification session for the mobile SDK / webview. */
export class KycTokenDto {
  @ApiProperty({ description: 'Didit session id. Stored server-side; echoed in the webhook.' })
  sessionId!: string;

  @ApiProperty({
    description:
      'Didit session token. Pass to the native SDK, e.g. DiditSdk.startVerification(sessionToken).',
  })
  sessionToken!: string;

  @ApiProperty({
    description: 'Hosted verification URL — open in a webview as a fallback to the native SDK.',
  })
  url!: string;

  @ApiProperty({
    enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
    description: 'kycStatus at session creation. The /api/webhook/didit callback updates it after review.',
  })
  kycStatus!: string;
}

/** `POST /affiliate/visits` & `POST /affiliate/attribution` — visit log outcome. */
export class VisitLogResultDto {
  @ApiProperty({
    enum: ['logged', 'duplicate', 'invalid', 'error'],
    example: 'logged',
    description: 'Outcome. Always HTTP 200 — never breaks marketing ad links.',
  })
  status!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Set when status is `logged` or `duplicate`.' })
  visitId?: string;

  @ApiPropertyOptional({ description: 'Set when status is `invalid` or `error`.' })
  reason?: string;
}
