import { ApiProperty } from '@bb/common/openapi/decorators';

/** One selectable post kind (§4). */
export class PostKindDto {
  @ApiProperty({ format: 'uuid', example: '01991a00-0000-7000-8000-000000000003' })
  kindId!: string;

  @ApiProperty({ example: 'Diskusi' })
  name!: string;
}

/** Response for `GET /api/community/post-kinds` — array order IS display order. */
export class PostKindListDto {
  @ApiProperty({ type: 'array', itemType: () => PostKindDto })
  items!: PostKindDto[];
}
