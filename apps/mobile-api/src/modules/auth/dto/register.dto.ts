import { IsEmail, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { NormalizeEmail } from '@bb/common/utils/transform.util';

export class RegisterDto {
  @ApiProperty({ format: 'email', example: 'user@example.com' })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  @ApiProperty({ format: 'password', example: 'secret123', description: 'min 8 chars' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({
    example: 'Jane Doe',
    description: '4-100 chars. Accepts `name` as alias (FE legacy register sends `name`).',
  })
  @IsString()
  @Length(4, 100)
  @Transform(({ value, obj }) =>
    typeof value === 'string' && value.length > 0
      ? value
      : ((obj as { name?: unknown }).name as string | undefined),
  )
  fullName!: string;

  @ApiPropertyOptional({ example: '+628111111111' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{6,20}$/, { message: 'phone must be 6-20 digits, optional leading +' })
  phone?: string;

  @ApiPropertyOptional({ example: '+62' })
  @IsOptional()
  @IsString()
  phoneCode?: string;

  @ApiPropertyOptional({ example: 'janedoe' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({
    example: '1990-05-12',
    description: 'Birthdate ISO date string',
  })
  @IsOptional()
  @IsString()
  birthdate?: string;

  @ApiPropertyOptional({ enum: ['MAN', 'WOMEN'], example: 'WOMEN' })
  @IsOptional()
  @IsString()
  gender?: string;

  @ApiPropertyOptional({
    example: 'JD000001-42',
    description:
      'Affiliate code. First 8 chars = inviter member code; remaining chars = network legacy id (optional).',
  })
  @IsOptional()
  @IsString()
  affiliateCode?: string;

  @ApiPropertyOptional({ enum: ['ios', 'android', 'web'], example: 'android' })
  @IsOptional()
  @IsString()
  registerFrom?: string;

  @ApiPropertyOptional({ example: 'google' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ example: 'summer-promo-2024' })
  @IsOptional()
  @IsString()
  utmContent?: string;
}
