import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class VerifyEmailDto {
  @ApiProperty({ example: '1234', description: '4-digit OTP sent to registered email' })
  @IsString()
  @Length(4, 4)
  code!: string;
}
