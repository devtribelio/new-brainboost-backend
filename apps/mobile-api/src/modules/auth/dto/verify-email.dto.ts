import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class VerifyEmailDto {
  @ApiProperty({ example: '123456', description: '6-digit OTP sent to registered email' })
  @IsString()
  @Length(6, 6)
  code!: string;
}
