import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@/common/openapi/decorators';

export class GetPaymentTokenQueryDto {
  @ApiPropertyOptional({ example: 'pay_abc123', description: 'Internal payment record id' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    example: 'course',
    description:
      'Payment context type (multilink|commerce|event|businessAccount|canvas|topic|membership|storage|donation|course|book)',
  })
  @IsOptional()
  @IsString()
  type?: string;
}
