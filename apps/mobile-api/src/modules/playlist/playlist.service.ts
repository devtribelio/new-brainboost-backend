import { prisma } from '@bb/db';
import type { Playlist } from '@prisma/client';
import { badRequest, forbidden, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { toPlainText } from '@bb/common/utils/plain-text.util';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { activeEnrollment } from '@bb/domain/commerce/enrollment';
import { buildStreamUrl, findLessonAudio } from '@/modules/media/media-asset.util';
import {
  PLAYLIST_MAX_ITEMS_DEFAULT,
  PLAYLIST_MAX_PER_MEMBER_DEFAULT,
  PLAYLIST_NAME_MAX_CHARS,
  PLAYLIST_VISIBILITY,
  QUOTA_UNLIMITED,
} from './playlist.constants';

/** One playable row of a playlist, already resolved against the viewer's access. */
export interface PlaylistItemView {
  lessonId: string;
  courseId: string;
  name: string;
  durationSec: number;
  order: number;
  locked: boolean;
  streamUrl: string | null;
}

export interface PlaylistDetailView {
  playlist: Playlist;
  items: PlaylistItemView[];
  totalItems: number;
  lockedItems: number;
  interludeStreamUrl: string | null;
  requiresSubscription: boolean;
  isOwner: boolean;
}

export interface QuotaView {
  /** null = unlimited. The `-1` sentinel never leaves the service. */
  limit: number | null;
  used: number;
  remaining: number | null;
}

const itemInclude = {
  lesson: {
    include: { section: { select: { courseId: true } } },
  },
} as const;

export class PlaylistService {
  constructor(private readonly entitlement = new EntitlementService()) {}

  // --- gate ------------------------------------------------------------------

  /**
   * Feature gate. Playing and every write require an active subscription — grace
   * included, because `getActiveSubscriptionForMember` already encodes it and a
   * second definition of "active" is how payment bugs are born.
   *
   * A free-trial voucher grants a time-boxed enrollment but no subscription, so a
   * trial member is deliberately blocked: playlists are a subscription benefit,
   * not a trial benefit (docs/playlist-port.md §2b).
   */
  async assertAccess(memberId: string): Promise<void> {
    if (await this.hasAccess(memberId)) return;
    throw forbidden(ERROR_CODES.PLAYLIST_SUBSCRIPTION_REQUIRED);
  }

  async hasAccess(memberId: string): Promise<boolean> {
    if (!(await this.requiresSubscription())) return true;
    return this.entitlement.hasActiveSubscription(memberId);
  }

  private async requiresSubscription(): Promise<boolean> {
    return settingsService.getBoolean(SETTING_KEYS.playlistRequiresSubscription, true);
  }

  // --- quota -----------------------------------------------------------------

  /**
   * Resolution order: per-member override wins over the global setting, in BOTH
   * directions — the column is as much a punishment lane as a VIP lane. `-1` is
   * unlimited, `0` blocks creation entirely (`0` is NOT unlimited).
   */
  private async resolveLimit(memberId: string): Promise<number> {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { playlistQuota: true },
    });
    if (member?.playlistQuota != null) return member.playlistQuota;
    return settingsService.getNumber(
      SETTING_KEYS.playlistMaxPerMember,
      PLAYLIST_MAX_PER_MEMBER_DEFAULT,
    );
  }

  async getQuota(memberId: string): Promise<QuotaView> {
    const [limit, used] = await Promise.all([
      this.resolveLimit(memberId),
      prisma.playlist.count({ where: { ownerId: memberId } }),
    ]);
    if (limit === QUOTA_UNLIMITED) return { limit: null, used, remaining: null };
    return { limit, used, remaining: Math.max(0, limit - used) };
  }

  /**
   * Enforced on create only — never on rename/reorder/delete. A member who ended
   * up over the cap because it was lowered must still be able to tidy up.
   */
  private async assertQuota(memberId: string): Promise<void> {
    const limit = await this.resolveLimit(memberId);
    if (limit === QUOTA_UNLIMITED) return;
    const used = await prisma.playlist.count({ where: { ownerId: memberId } });
    if (used >= limit) {
      throw badRequest(ERROR_CODES.PLAYLIST_QUOTA_EXCEEDED, { limit, current: used });
    }
  }

  private async maxItems(): Promise<number> {
    return settingsService.getNumber(SETTING_KEYS.playlistMaxItems, PLAYLIST_MAX_ITEMS_DEFAULT);
  }

  // --- reads -----------------------------------------------------------------

  async listMine(memberId: string) {
    const rows = await prisma.playlist.findMany({
      where: { ownerId: memberId, isBlocked: false },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { items: true } } },
    });
    return rows;
  }

  private async ownedOrThrow(memberId: string, playlistId: string): Promise<Playlist> {
    const row = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!row || row.isBlocked) throw notFound(ERROR_CODES.PLAYLIST_NOT_FOUND);
    if (row.ownerId !== memberId) throw forbidden(ERROR_CODES.PLAYLIST_FORBIDDEN);
    return row;
  }

  /**
   * Detail + playable URLs.
   *
   * Reads only. It must NEVER call `EntitlementService.assertCourseAccess`: that
   * one WRITES a lazy enrollment row, so browsing N playlists would silently
   * mint enrollments for courses the member never opened. The lazy row is still
   * created at the right moment — `/media/stream`, when the audio actually plays.
   */
  async detail(playlistId: string, viewerId: string): Promise<PlaylistDetailView> {
    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist || playlist.isBlocked) throw notFound(ERROR_CODES.PLAYLIST_NOT_FOUND);
    if (playlist.ownerId !== viewerId) throw forbidden(ERROR_CODES.PLAYLIST_FORBIDDEN);

    const rows = await prisma.playlistItem.findMany({
      where: { playlistId: playlist.id },
      orderBy: { order: 'asc' },
      include: itemInclude,
    });

    const unlocked = await this.unlockedCourseIds(
      viewerId,
      rows.map((r) => r.lesson.section.courseId),
    );

    const items: PlaylistItemView[] = [];
    for (const row of rows) {
      const audio = findLessonAudio(row.lesson.slidesData);
      // A lesson with no audio slide is not playable from a playlist. Dropping it
      // beats rendering a dead row the player would choke on.
      if (!audio) continue;
      const courseId = row.lesson.section.courseId;
      const locked = !unlocked.has(courseId);
      items.push({
        lessonId: row.lessonId,
        courseId,
        name: row.lesson.name,
        durationSec: audio.durationSec || row.lesson.duration,
        order: row.order,
        locked,
        streamUrl: locked ? null : buildStreamUrl(audio.guid, courseId, row.lesson.isPreview),
      });
    }

    return {
      playlist,
      items,
      totalItems: items.length,
      lockedItems: items.filter((i) => i.locked).length,
      interludeStreamUrl: await this.interludeStreamUrl(),
      requiresSubscription: await this.requiresSubscription(),
      isOwner: playlist.ownerId === viewerId,
    };
  }

  /**
   * Which of these courses the viewer may play, in ONE query.
   *
   * A subscriber holds all of them — the subscription is all-access — so the
   * per-course lookup is skipped entirely. Only when the kill-switch has opened
   * the feature to non-subscribers does it fall through to enrollments, and then
   * the filter is `activeEnrollment()` ("may consume the content now", trial
   * included) — NOT `OWNED_FOR_PURCHASE`, which answers a different question and
   * would lock subscribers out of audio `/media/stream` happily serves.
   */
  private async unlockedCourseIds(memberId: string, courseIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(courseIds)];
    if (unique.length === 0) return new Set();
    if (await this.entitlement.hasActiveSubscription(memberId)) return new Set(unique);

    const rows = await prisma.courseEnrollment.findMany({
      where: { memberId, courseId: { in: unique }, ...activeEnrollment() },
      select: { courseId: true },
    });
    return new Set(rows.map((r) => r.courseId));
  }

  /**
   * The interlude is one global asset, stored as a Bunny guid and minted per
   * request as an ordinary proxy URL. Storing the URL instead would hand the CDN
   * host and guid to the client, past the media proxy — no rate limit, no revoke.
   * Empty setting = interlude switched off.
   */
  private async interludeStreamUrl(): Promise<string | null> {
    const guid = (await settingsService.get(SETTING_KEYS.playlistInterludeAssetId, '')).trim();
    if (!guid) return null;
    // `isPreview: true` — the interlude is not course content and must play for
    // anyone the playlist itself already let in.
    return buildStreamUrl(guid, '', true);
  }

  // --- writes ----------------------------------------------------------------

  private normalizeName(raw: string): string {
    // Plain text at the point of WRITE: this name later shows up on a share page
    // and in notifications, and whatever is not normalised here leaks there.
    const name = toPlainText(raw ?? '').slice(0, PLAYLIST_NAME_MAX_CHARS).trim();
    if (!name) throw badRequest(ERROR_CODES.PLAYLIST_NAME_REQUIRED);
    return name;
  }

  async create(
    memberId: string,
    dto: { name: string; description?: string; coverUrl?: string; lessonIds?: string[] },
  ) {
    await this.assertAccess(memberId);
    await this.assertQuota(memberId);
    const name = this.normalizeName(dto.name);

    const playlist = await prisma.playlist.create({
      data: {
        ownerId: memberId,
        name,
        description: dto.description ?? null,
        coverUrl: dto.coverUrl ?? null,
        visibility: PLAYLIST_VISIBILITY.private,
      },
    });

    // Items in the same call on purpose: the "add to playlist → new playlist"
    // sheet is the main entry point, and splitting it in two leaves an empty
    // playlist stranded whenever the second call fails.
    const added = dto.lessonIds?.length
      ? await this.addItems(memberId, playlist.id, dto.lessonIds)
      : { added: 0, alreadyPresent: 0, skipped: [] as string[] };

    return { playlist, ...added };
  }

  async update(
    memberId: string,
    playlistId: string,
    dto: { name?: string; description?: string | null; coverUrl?: string | null },
  ) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    return prisma.playlist.update({
      where: { id: playlistId },
      data: {
        ...(dto.name !== undefined ? { name: this.normalizeName(dto.name) } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
      },
    });
  }

  async remove(memberId: string, playlistId: string): Promise<void> {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    await prisma.playlist.delete({ where: { id: playlistId } });
  }

  /**
   * Append lessons at the end, in the order given.
   *
   * A lesson already in the playlist is NOT an error: the bottom sheet hits that
   * case constantly (the member forgot), and a 409 there reads as a bug. Unknown
   * or inactive ids are dropped and reported rather than failing the whole call —
   * one stale id from a client cache must not sink the request.
   */
  async addItems(memberId: string, playlistId: string, lessonIds: string[]) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    const requested = [...new Set(lessonIds)];
    if (requested.length === 0) throw badRequest(ERROR_CODES.PLAYLIST_ITEMS_REQUIRED);

    const lessons = await prisma.lesson.findMany({
      where: { id: { in: requested }, lessonStatus: 'ACTIVE' },
      select: { id: true },
    });
    const valid = new Set(lessons.map((l) => l.id));
    const skipped = requested.filter((id) => !valid.has(id));

    const existing = await prisma.playlistItem.findMany({
      where: { playlistId },
      select: { lessonId: true, order: true },
    });
    const present = new Set(existing.map((e) => e.lessonId));
    const toAdd = requested.filter((id) => valid.has(id) && !present.has(id));

    const limit = await this.maxItems();
    if (existing.length + toAdd.length > limit) {
      throw badRequest(ERROR_CODES.PLAYLIST_ITEM_LIMIT_EXCEEDED, {
        limit,
        current: existing.length,
      });
    }

    let nextOrder = existing.reduce((max, e) => Math.max(max, e.order), 0) + 1;
    if (toAdd.length > 0) {
      await prisma.playlistItem.createMany({
        data: toAdd.map((lessonId) => ({ playlistId, lessonId, order: nextOrder++ })),
        skipDuplicates: true,
      });
      await prisma.playlist.update({ where: { id: playlistId }, data: { updatedAt: new Date() } });
    }

    return {
      added: toAdd.length,
      alreadyPresent: requested.filter((id) => present.has(id)).length,
      skipped,
    };
  }

  async removeItems(memberId: string, playlistId: string, lessonIds: string[]) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    if (lessonIds.length === 0) throw badRequest(ERROR_CODES.PLAYLIST_ITEMS_REQUIRED);
    const { count } = await prisma.playlistItem.deleteMany({
      where: { playlistId, lessonId: { in: lessonIds } },
    });
    return { removed: count };
  }

  /**
   * Rewrite the whole order from the final array the client sends.
   *
   * Not a per-item patch: a patch that fails halfway leaves an order the server
   * cannot repair. Ids absent from the array keep their relative order at the
   * end, so a stale client can only misplace what it knew about.
   */
  async reorder(memberId: string, playlistId: string, lessonIds: string[]) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);

    const rows = await prisma.playlistItem.findMany({
      where: { playlistId },
      orderBy: { order: 'asc' },
      select: { id: true, lessonId: true },
    });
    const byLesson = new Map(rows.map((r) => [r.lessonId, r.id]));
    const ordered = [
      ...lessonIds.filter((id) => byLesson.has(id)),
      ...rows.map((r) => r.lessonId).filter((id) => !lessonIds.includes(id)),
    ];

    await prisma.$transaction(
      ordered.map((lessonId, index) =>
        prisma.playlistItem.update({
          where: { id: byLesson.get(lessonId)! },
          data: { order: index + 1 },
        }),
      ),
    );
    return { reordered: ordered.length };
  }
}
