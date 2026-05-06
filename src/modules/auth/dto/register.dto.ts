import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@/common/openapi/decorators';

export class RegisterDto {
  @ApiProperty({ format: 'email', example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ format: 'password', example: 'secret123', description: 'min 8 chars' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({ example: '+628111111111' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;
}
