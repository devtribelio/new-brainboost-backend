import type { Response } from 'express';
import { PlaylistService } from './playlist.service';
import { ok, okCreated } from '@bb/common/utils/response.util';
import { badRequest, ERROR_CODES } from '@bb/common/exceptions';
import type { AuthenticatedRequest } from '@bb/common/interfaces/authenticated-request';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@bb/common/openapi/decorators';
import {
  serializePlaylist,
  serializePlaylistDetail,
  serializeSharedPlaylist,
} from './playlist.serializer';
import { PlaylistDetailDto, PlaylistDto } from './dto/playlist.dto';
import { CreatePlaylistDto, PlaylistItemsDto, UpdatePlaylistDto } from './dto/create-playlist.dto';

@ApiTags('Playlist')
export class PlaylistController {
  constructor(private readonly playlistService: PlaylistService) {}

  private id(req: AuthenticatedRequest): string {
    const id = req.params.id;
    if (!id) throw badRequest(ERROR_CODES.PLAYLIST_NOT_FOUND);
    return id;
  }

  @ApiOperation({ summary: "List the caller's playlists" })
  @ApiResponse({ status: 200, type: () => PlaylistDto, isArray: true })
  list = async (req: AuthenticatedRequest, res: Response) => {
    const memberId = req.user!.id;
    const [rows, quota] = await Promise.all([
      this.playlistService.listMine(memberId),
      this.playlistService.getQuota(memberId),
    ]);
    // Readable without a subscription on purpose: a member whose plan lapsed must
    // still see what they built, read-only, with a renew prompt over it.
    return ok(
      res,
      rows.map((r) => serializePlaylist(r)),
      { quota, hasAccess: await this.playlistService.hasAccess(memberId) },
    );
  };

  @ApiOperation({ summary: 'Playlist detail with playable URLs' })
  @ApiResponse({ status: 200, type: () => PlaylistDetailDto })
  detail = async (req: AuthenticatedRequest, res: Response) => {
    const view = await this.playlistService.detail(this.id(req), req.user!.id);
    return ok(res, serializePlaylistDetail(view));
  };

  @ApiOperation({ summary: 'Create a playlist, optionally with its first items' })
  @ApiBody({ type: () => CreatePlaylistDto })
  @ApiResponse({ status: 201, type: () => PlaylistDto })
  create = async (req: AuthenticatedRequest, res: Response) => {
    const memberId = req.user!.id;
    const result = await this.playlistService.create(memberId, req.body as CreatePlaylistDto);
    const quota = await this.playlistService.getQuota(memberId);
    return okCreated(
      res,
      {
        ...serializePlaylist(result.playlist),
        totalItems: result.added,
      },
      { quota, added: result.added, alreadyPresent: result.alreadyPresent, skipped: result.skipped },
    );
  };

  @ApiOperation({ summary: 'Rename a playlist / edit its description or cover' })
  @ApiBody({ type: () => UpdatePlaylistDto })
  @ApiResponse({ status: 200, type: () => PlaylistDto })
  update = async (req: AuthenticatedRequest, res: Response) => {
    const row = await this.playlistService.update(
      req.user!.id,
      this.id(req),
      req.body as UpdatePlaylistDto,
    );
    return ok(res, serializePlaylist(row));
  };

  @ApiOperation({ summary: 'Delete a playlist' })
  @ApiResponse({ status: 200 })
  remove = async (req: AuthenticatedRequest, res: Response) => {
    await this.playlistService.remove(req.user!.id, this.id(req));
    return ok(res, { deleted: true });
  };

  @ApiOperation({ summary: 'Append audio to a playlist' })
  @ApiBody({ type: () => PlaylistItemsDto })
  @ApiResponse({ status: 200 })
  addItems = async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as PlaylistItemsDto;
    const result = await this.playlistService.addItems(req.user!.id, this.id(req), body.lessonIds);
    return ok(res, result);
  };

  @ApiOperation({ summary: 'Remove audio from a playlist' })
  @ApiBody({ type: () => PlaylistItemsDto })
  @ApiResponse({ status: 200 })
  removeItems = async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as PlaylistItemsDto;
    const result = await this.playlistService.removeItems(
      req.user!.id,
      this.id(req),
      body.lessonIds,
    );
    return ok(res, result);
  };

  @ApiOperation({ summary: 'Rewrite item order from the final array' })
  @ApiBody({ type: () => PlaylistItemsDto })
  @ApiResponse({ status: 200 })
  reorder = async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as PlaylistItemsDto;
    const result = await this.playlistService.reorder(req.user!.id, this.id(req), body.lessonIds);
    return ok(res, result);
  };

  @ApiOperation({ summary: 'Switch sharing on (idempotent) or rotate the link' })
  @ApiResponse({ status: 200 })
  share = async (req: AuthenticatedRequest, res: Response) => {
    const rotate = req.query.rotate === 'true' || req.query.rotate === '1';
    const result = await this.playlistService.share(req.user!.id, this.id(req), rotate);
    return ok(res, {
      shareToken: result.shareToken,
      sharedAt: result.sharedAt?.toISOString() ?? null,
    });
  };

  @ApiOperation({ summary: 'Withdraw the share link' })
  @ApiResponse({ status: 200 })
  unshare = async (req: AuthenticatedRequest, res: Response) => {
    await this.playlistService.unshare(req.user!.id, this.id(req));
    return ok(res, { shared: false });
  };

  @ApiOperation({ summary: 'Open a shared playlist (public — never answers 401)' })
  @ApiResponse({ status: 200, type: () => PlaylistDetailDto })
  shared = async (req: AuthenticatedRequest, res: Response) => {
    const token = req.params.token;
    if (!token) throw badRequest(ERROR_CODES.PLAYLIST_NOT_FOUND);
    const view = await this.playlistService.detailByShareToken(token, req.user?.id);
    return ok(res, serializeSharedPlaylist(view));
  };

  @ApiOperation({ summary: 'Save a shared playlist into your own library' })
  @ApiResponse({ status: 200, type: () => PlaylistDto })
  saveShared = async (req: AuthenticatedRequest, res: Response) => {
    const token = req.params.token;
    if (!token) throw badRequest(ERROR_CODES.PLAYLIST_NOT_FOUND);
    const memberId = req.user!.id;
    const { playlist, created } = await this.playlistService.saveFromShare(memberId, token);
    const quota = await this.playlistService.getQuota(memberId);
    return ok(res, serializePlaylist(playlist), { quota, created });
  };
}
