import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';

export class ClaimSeatDto {
  @ApiProperty({ example: 'K7MPQ2WX9A', description: 'Invite code shared by the owner' })
  @IsString()
  @IsNotEmpty()
  code!: string;
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
