import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@bb/common/openapi/decorators';
import { PLAYLIST_NAME_MAX_CHARS } from '../playlist.constants';

/** Body of `POST /api/member/playlist`. */
export class CreatePlaylistDto {
  @ApiProperty({ example: 'Pagi Fokus', description: `Max ${PLAYLIST_NAME_MAX_CHARS} chars` })
  @IsString()
  @MaxLength(PLAYLIST_NAME_MAX_CHARS)
  name!: string;

  @ApiPropertyOptional({ example: 'Rangkaian audio untuk memulai hari' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'https://cdn.brainboost.id/cover.webp' })
  @IsOptional()
  @IsString()
  coverUrl?: string;

  @ApiPropertyOptional({
    type: 'array',
    itemType: 'string',
    description:
      'Optional first items, as slide ids from course detail (`slides[].id`). Sent together with the name so the "add to a new playlist" sheet is one call, not two.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  audioIds?: string[];
}

/** Body of `PATCH /api/member/playlist/:id`. */
export class UpdatePlaylistDto {
  @ApiPropertyOptional({ example: 'Pagi Fokus v2', description: `Max ${PLAYLIST_NAME_MAX_CHARS} chars` })
  @IsOptional()
  @IsString()
  @MaxLength(PLAYLIST_NAME_MAX_CHARS)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  coverUrl?: string;
}

/** Body of the item add/remove/reorder routes. */
export class PlaylistItemsDto {
  @ApiProperty({
    type: 'array',
    itemType: 'string',
    description: 'Slide ids from course detail (`slides[].id`) — NOT lesson ids',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  audioIds!: string[];
}
