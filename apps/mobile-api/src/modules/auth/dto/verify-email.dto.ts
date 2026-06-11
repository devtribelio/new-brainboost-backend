import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class VerifyEmailDto {
  @ApiProperty({ example: '123456', description: '6-digit OTP sent to registered email' })
  @IsString()
  // 4 still accepted during the 4→6 digit transition (in-flight codes).
  @Length(4, 8)
  code!: string;
}
