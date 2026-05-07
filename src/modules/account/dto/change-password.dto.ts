import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@/common/openapi/decorators';

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  oldPassword!: string;

  @ApiProperty({ format: 'password', description: 'min 6 chars (legacy)' })
  @IsString()
  @Length(6, 100)
  newPassword!: string;

  @ApiProperty({ format: 'password', description: 'must equal newPassword' })
  @IsString()
  @Length(6, 100)
  confirmNewPassword!: string;
}
