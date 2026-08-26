import { ArrayMaxSize, IsArray, IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class ClaimSeatDto {
  @ApiProperty({ example: 'K7MPQ2WX9A', description: 'Invite code shared by the owner' })
  @IsString()
  @IsNotEmpty()
  code!: string;
}

export class DeclarePendingChangeDto {
  @ApiProperty({ example: 'SOLO_12M', description: 'Plan to move down to at the end of the term' })
  @IsString()
  @IsNotEmpty()
  planCode!: string;
}

export class ChooseSeatsDto {
  @ApiProperty({
    type: 'array',
    itemType: 'string',
    description:
      'Seats that keep their access when the smaller plan lands. The owner’s seat is always kept and does not need to be listed.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  seatIds!: string[];
}

export class PendingChangeDto {
  @ApiProperty({ example: 'SOLO_12M' })
  planCode!: string;

  @ApiProperty({ example: 'SOLO' })
  tier!: string;

  @ApiProperty({ example: 1 })
  seatCount!: number;

  @ApiProperty({ description: 'The change lands on this date — nothing changes before it' })
  effectiveAt!: Date;

  @ApiProperty({
    example: true,
    description: 'More seats are occupied than the new plan allows — the owner must choose',
  })
  mustEvict!: boolean;

  @ApiProperty({
    example: false,
    description:
      'False for a store-managed subscription: Apple/Google own the schedule, so it can only be reverted from the store’s subscription settings.',
  })
  canCancel!: boolean;

  @ApiProperty({
    description:
      'Product to check out once the term ends. `renewal.productId` deliberately keeps pointing at the CURRENT plan, which is the only one buyable while the term still runs.',
  })
  productId!: string;
}

/** What would happen if the member picked this plan right now. */
export class PlanQuoteDto {
  @ApiProperty({ example: 'FAMILY_12M' })
  planCode!: string;

  @ApiProperty({ example: 'FAMILY' })
  tier!: string;

  @ApiProperty({ example: 4 })
  seatCount!: number;

  @ApiProperty({ description: 'Pass to POST /commerce/checkout when payableNow is true' })
  productId!: string;

  @ApiProperty({
    example: 'upgrade',
    enum: ['purchase', 'renewal', 'upgrade', 'downgrade'],
    description: 'What picking this plan means for the caller, given what they hold today.',
  })
  action!: string;

  @ApiProperty({ example: 1_999_000, description: 'List price of the target plan' })
  price!: number;

  @ApiProperty({
    example: 725_301,
    description: 'Unused term credited back. Non-zero on an upgrade only.',
  })
  prorationCredit!: number;

  @ApiProperty({ example: 1_273_699, description: 'price − prorationCredit' })
  amount!: number;

  @ApiProperty({
    example: true,
    description:
      'Whether checkout would accept this plan RIGHT NOW. Mirrors the checkout guard exactly — render "Bayar" when true, and the scheduling/waiting CTA when false.',
  })
  payableNow!: boolean;

  @ApiPropertyOptional({
    example: 'term_running',
    nullable: true,
    enum: ['not_scheduled', 'term_running', 'seated_elsewhere'],
    description: 'Why checkout would refuse. Null when payableNow is true.',
  })
  payableReason?: string | null;

  @ApiPropertyOptional({
    example: 265,
    nullable: true,
    description: 'Days left on the running term; drives the credit. Null when there is no term.',
  })
  remainingDays?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When a downgrade would take effect. Null for the other actions.',
  })
  effectiveAt?: Date | null;
}

export class PlanItemDto {
  @ApiProperty({ example: 'SOLO_12M' })
  planCode!: string;

  @ApiProperty({ example: 'SOLO' })
  tier!: string;

  @ApiProperty({ example: 12 })
  periodMonths!: number;

  @ApiProperty({ example: 1, description: 'Seats; seat 1 is the owner' })
  seatCount!: number;

  @ApiProperty({ description: 'Product to pass to the commerce checkout endpoints' })
  productId!: string;

  @ApiProperty({ example: 'BrainBoost Solo — Langganan 1 Tahun (1 device)' })
  title!: string;

  @ApiProperty({ example: 999000, description: 'Web price (IDR) from Product.price' })
  price!: number;

  @ApiPropertyOptional({
    example: 'com.brainboost.ios.sub_solo_annual',
    nullable: true,
    description: 'App Store SKU for the IAP purchase path (RevenueCat)',
  })
  iosProductId?: string | null;

  @ApiPropertyOptional({
    example: 'com.brainboost.android.sub_solo_annual',
    nullable: true,
    description: 'Play Store SKU for the IAP purchase path (RevenueCat)',
  })
  androidProductId?: string | null;

  @ApiPropertyOptional({
    example: 1099000,
    nullable: true,
    description:
      'Gross iOS IAP display price (IDR, marked up to offset Apple’s cut). null = same as web price.',
  })
  iosPrice?: number | null;
}

export class SeatItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 1 })
  seatNo!: number;

  @ApiProperty({ example: true })
  claimed!: boolean;

  @ApiPropertyOptional({ example: 'John Doe', nullable: true })
  memberName?: string | null;

  @ApiPropertyOptional({ example: true, description: 'This seat is the caller' })
  isMe?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Owner picked this seat to survive the pending downgrade',
  })
  keepOnChange?: boolean;
}

export class RenewalInfoDto {
  @ApiProperty({ description: 'Repurchase this product to extend the subscription' })
  productId!: string;
}

export class SubscriptionMeDto {
  @ApiProperty({ example: 'owner', enum: ['owner', 'member', 'none'] })
  role!: string;

  @ApiPropertyOptional({ example: 'ACTIVE' })
  status?: string;

  @ApiPropertyOptional({ example: 'SOLO_12M' })
  planCode?: string;

  @ApiPropertyOptional({ example: 'SOLO' })
  tier?: string;

  @ApiPropertyOptional()
  expiresAt?: Date;

  @ApiPropertyOptional({ nullable: true })
  graceUntil?: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Cancel-intent timestamp — access continues until expiresAt',
  })
  canceledAt?: Date | null;

  @ApiPropertyOptional({ example: 'xendit', description: 'xendit | revenuecat | granted' })
  source?: string;

  @ApiPropertyOptional({ type: () => [SeatItemDto], description: 'Owner only' })
  seats?: SeatItemDto[];

  @ApiPropertyOptional({ type: () => SeatItemDto, description: 'Member only — the caller’s seat' })
  seat?: SeatItemDto;

  @ApiPropertyOptional({ type: () => RenewalInfoDto })
  renewal?: RenewalInfoDto;

  @ApiPropertyOptional({
    type: () => PendingChangeDto,
    nullable: true,
    description: 'A scheduled tier change. Absent when there is none.',
  })
  pendingChange?: PendingChangeDto | null;
}

export class InviteResponseDto {
  @ApiProperty({ example: 'K7MPQ2WX9A' })
  inviteCode!: string;

  @ApiProperty({ example: 2 })
  seatNo!: number;
}

export class CancelResponseDto {
  @ApiProperty({ example: true })
  canceled!: boolean;

  @ApiProperty({ description: 'Access continues until this date' })
  expiresAt!: Date;
}
