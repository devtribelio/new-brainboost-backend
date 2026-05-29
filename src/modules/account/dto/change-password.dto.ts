import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@bb/common/openapi/decorators';

export class ChangePasswordDto {
  @ApiProperty({ format: 'password', example: 'oldS3cret' })
  @IsString()
  oldPassword!: string;

  @ApiProperty({
    format: 'password',
    example: 'N3wP4ssw0rd!',
    description: 'min 6 chars (legacy)',
  })
  @IsString()
  @Length(6, 100)
  newPassword!: string;

  @ApiProperty({
    format: 'password',
    example: 'N3wP4ssw0rd!',
    description: 'must equal newPassword',
  })
  @IsString()
  @Length(6, 100)
  confirmNewPassword!: string;
}
