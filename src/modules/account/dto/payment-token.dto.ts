import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@/common/openapi/decorators';

export class GetPaymentTokenQueryDto {
  @ApiPropertyOptional({ description: 'Internal payment record id' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description:
      'Payment context type (multilink|commerce|event|businessAccount|canvas|topic|membership|storage|donation|course|book)',
  })
  @IsOptional()
  @IsString()
  type?: string;
}
