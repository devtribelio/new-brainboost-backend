import { IsIn, IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

/** Post-login contact verification — one pair of endpoints for both channels. */
export class RequestVerifyDto {
  @ApiProperty({ enum: ['email', 'phone'], example: 'phone' })
  @IsIn(['email', 'phone'])
  type!: 'email' | 'phone';
}

// Deliberately NOT `extends RequestVerifyDto` — the OpenAPI registry walks
// decorator metadata up the prototype chain, so inheriting leaks `code` into
// the parent's Swagger schema.
export class VerifyDto {
  @ApiProperty({ enum: ['email', 'phone'], example: 'phone' })
  @IsIn(['email', 'phone'])
  type!: 'email' | 'phone';

  @ApiProperty({ example: '123456', description: '6-digit OTP' })
  @IsString()
  // 4 still accepted during the 4→6 digit transition (in-flight codes).
  @Length(4, 8)
  code!: string;
}
