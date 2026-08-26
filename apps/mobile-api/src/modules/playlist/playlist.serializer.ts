import type { Playlist } from '@prisma/client';
import type {
  PlaylistDetailView,
  PlaylistHistoryRow,
  PlaylistItemView,
  SharedPlaylistView,
} from './playlist.service';

type PlaylistWithCount = Playlist & { _count?: { items: number } };

export function serializePlaylist(p: PlaylistWithCount, isOwner = true): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    coverUrl: p.coverUrl,
    visibility: p.visibility,
    totalItems: p._count?.items ?? 0,
    // Not computed on the list: it would cost one entitlement resolution per
    // playlist. The detail response carries the real number.
    lockedItems: 0,
    isOwner,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function serializeItem(i: PlaylistItemView): Record<string, unknown> {
  return {
    lessonId: i.lessonId,
    courseId: i.courseId,
    name: i.name,
    durationSec: i.durationSec,
    order: i.order,
    locked: i.locked,
    streamUrl: i.streamUrl,
  };
}

export function serializePlaylistDetail(v: PlaylistDetailView): Record<string, unknown> {
  return {
    ...serializePlaylist(v.playlist, v.isOwner),
    totalItems: v.totalItems,
    lockedItems: v.lockedItems,
    requiresSubscription: v.requiresSubscription,
    interludeStreamUrl: v.interludeStreamUrl,
    items: v.items.map(serializeItem),
  };
}

export function serializeSharedPlaylist(v: SharedPlaylistView): Record<string, unknown> {
  return {
    ...serializePlaylistDetail(v),
    isSaved: v.isSaved,
    canSave: v.canSave,
  };
}

/** Recent/top row: the playlist plus what the listening log says about it. */
export function serializePlaylistHistory(
  row: PlaylistHistoryRow,
  viewerId: string,
): Record<string, unknown> {
  return {
    ...serializePlaylist(row.playlist, row.playlist.ownerId === viewerId),
    lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
    totalListenedSec: row.totalListenedSec,
  };
}
