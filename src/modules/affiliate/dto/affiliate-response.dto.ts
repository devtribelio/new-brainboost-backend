import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

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
