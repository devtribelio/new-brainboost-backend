import { randomBytes } from 'node:crypto';
import { prisma } from '@bb/db';
import type { Playlist } from '@prisma/client';
import { badRequest, forbidden, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { toPlainText } from '@bb/common/utils/plain-text.util';
import { EntitlementService } from '@bb/domain/subscription/entitlement.service';
import { activeEnrollment } from '@bb/domain/commerce/enrollment';
import {
  PLAYABLE_SLIDE_TYPES,
  buildStreamUrl,
  findPlayableAudio,
} from '@/modules/media/media-asset.util';
import {
  PLAYLIST_MAX_ITEMS_DEFAULT,
  PLAYLIST_MAX_PER_MEMBER_DEFAULT,
  PLAYLIST_NAME_MAX_CHARS,
  PLAYLIST_VISIBILITY,
  INTERLUDE_AUDIO_ID,
  PLAYLIST_HISTORY_LIMIT,
  PLAYLIST_PLAYED_MIN_SEC,
  PLAYLIST_TOP_RANGE_DAYS,
  QUOTA_UNLIMITED,
  SHARE_TOKEN_BYTES,
} from './playlist.constants';

/** One playable row of a playlist, already resolved against the viewer's access. */
export interface PlaylistItemView {
  /** The slide actually played — same id space as `listening_session.audioId`. */
  audioId: string;
  lessonId: string;
  courseId: string;
  name: string;
  durationSec: number;
  order: number;
  locked: boolean;
  streamUrl: string | null;
  /** Course artwork. Absolute URL; repeats across items of one course, by design. */
  coverUrl: string | null;
  /** `products.code` — what the app's course route takes. */
  courseCode: string | null;
}

export interface PlaylistDetailView {
  playlist: Playlist;
  /** Playlist artwork: its own, else the first item's course cover. */
  coverUrl: string | null;
  items: PlaylistItemView[];
  totalItems: number;
  lockedItems: number;
  interludeStreamUrl: string | null;
  /** Sentinel audio id for the interlude; null when the interlude is off. */
  interludeAudioId: string | null;
  requiresSubscription: boolean;
  isOwner: boolean;
}

/** What a share link resolves to. `isSaved` drives the button copy on the FE. */
export interface SharedPlaylistView extends PlaylistDetailView {
  isSaved: boolean;
  canSave: boolean;
}

/** A playlist plus what the listening log says about it, for recent/top. */
export interface PlaylistHistoryRow {
  playlist: Playlist & { _count?: { items: number } };
  lastPlayedAt: Date | null;
  totalListenedSec: number;
}

export interface QuotaView {
  /** null = unlimited. The `-1` sentinel never leaves the service. */
  limit: number | null;
  used: number;
  remaining: number | null;
}

const itemInclude = {
  lesson: {
    include: {
      section: {
        select: {
          courseId: true,
          // The item's display name is the PRODUCT title, not the lesson or slide
          // title (product decision, 2026-08-25). `thumbnail` and `code` ride the
          // same join: artwork cannot be resolved app-side (a locked item comes
          // from a course the member has never listed, so it is not in their local
          // cache), and `code` is what the course route takes.
          course: {
            select: { product: { select: { title: true, thumbnail: true, code: true } } },
          },
        },
      },
    },
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
    const covers = await this.firstItemCovers(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, coverUrl: r.coverUrl ?? covers.get(r.id) ?? null }));
  }

  /**
   * First item's course artwork, one row per playlist, in ONE query.
   *
   * `DISTINCT ON` rather than loading every item and picking the head: a playlist
   * holds up to 200 items and the list shows twenty playlists, so the naive
   * version reads thousands of rows to use twenty of them. Raw SQL because Prisma
   * has no DISTINCT ON.
   */
  private async firstItemCovers(playlistIds: string[]): Promise<Map<string, string>> {
    if (playlistIds.length === 0) return new Map();
    const rows = await prisma.$queryRaw<Array<{ playlist_id: string; thumbnail: string | null }>>`
      SELECT DISTINCT ON (pi.playlist_id) pi.playlist_id, p.thumbnail
      FROM playlist_items pi
      JOIN course_lessons l ON l.id = pi.lesson_id
      JOIN course_sections s ON s.id = l.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN products p ON p.id = c.product_id
      WHERE pi.playlist_id = ANY (${playlistIds}::uuid[])
      ORDER BY pi.playlist_id, pi."order" ASC
    `;
    return new Map(
      rows.filter((r) => r.thumbnail).map((r) => [r.playlist_id, r.thumbnail as string]),
    );
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
    return this.buildView(playlist, viewerId);
  }

  /**
   * Resolve a share link. Public on purpose — the whole point of a shared
   * playlist is to reach someone who is not a subscriber yet, and an anonymous
   * caller must be answered, never 401'd.
   *
   * A revoked token, a deleted playlist and an ops-blocked one all look
   * identical from here (404): a 403 would confirm the playlist exists.
   */
  async detailByShareToken(token: string, viewerId?: string): Promise<SharedPlaylistView> {
    const playlist = await prisma.playlist.findUnique({ where: { shareToken: token } });
    if (!playlist || playlist.isBlocked || !playlist.shareToken) {
      throw notFound(ERROR_CODES.PLAYLIST_NOT_FOUND);
    }

    const view = await this.buildView(playlist, viewerId);
    const isSaved = viewerId
      ? (await prisma.playlist.count({
          where: { ownerId: viewerId, copiedFromToken: token },
        })) > 0
      : false;

    return {
      ...view,
      isSaved,
      // Saving is a write, and every write needs a subscription. The FE turns
      // this into "Berlangganan untuk menyimpan" rather than a dead button.
      canSave: viewerId ? !isSaved && (await this.hasAccess(viewerId)) : false,
    };
  }

  /**
   * Shared item resolution. `viewerId` may be absent (anonymous share link).
   *
   * A preview lesson stays playable for everyone — that is the existing media
   * rule, and re-locking it here would contradict `/media/stream`, which is the
   * real gate.
   */
  private async buildView(playlist: Playlist, viewerId?: string): Promise<PlaylistDetailView> {
    const rows = await prisma.playlistItem.findMany({
      where: { playlistId: playlist.id },
      orderBy: { order: 'asc' },
      include: itemInclude,
    });

    const unlocked = viewerId
      ? await this.unlockedCourseIds(
          viewerId,
          rows.map((r) => r.lesson.section.courseId),
        )
      : new Set<string>();

    const items: PlaylistItemView[] = [];
    for (const row of rows) {
      const audio = findPlayableAudio(row.lesson.slidesData, row.audioId);
      // The slide is gone — the lesson was re-saved without it, or its id changed.
      // Dropping the row beats rendering an entry the player would choke on.
      if (!audio) continue;
      const courseId = row.lesson.section.courseId;
      const locked = !(unlocked.has(courseId) || row.lesson.isPreview);
      items.push({
        audioId: row.audioId,
        lessonId: row.lessonId,
        courseId,
        // Product title. Several items of the same course therefore read alike —
        // accepted trade-off, the lesson/slide titles are the distinguishing ones.
        name: row.lesson.section.course?.product?.title ?? row.lesson.name,
        coverUrl: row.lesson.section.course?.product?.thumbnail ?? null,
        courseCode: row.lesson.section.course?.product?.code ?? null,
        durationSec: audio.durationSec || row.lesson.duration,
        order: row.order,
        locked,
        streamUrl: locked ? null : buildStreamUrl(audio.guid, courseId, row.lesson.isPreview),
      });
    }

    const interludeStreamUrl = await this.interludeStreamUrl();

    return {
      playlist,
      // A member never sets a cover — there is no UI for it — so an unset one falls
      // back to the first item's course artwork instead of a grey placeholder. Kept
      // derived, never stored: storing it goes stale the moment the first item
      // changes (docs/playlist-port.md §6b).
      coverUrl: playlist.coverUrl ?? items.find((i) => i.coverUrl)?.coverUrl ?? null,
      items,
      totalItems: items.length,
      lockedItems: items.filter((i) => i.locked).length,
      interludeStreamUrl,
      interludeAudioId: interludeStreamUrl ? INTERLUDE_AUDIO_ID : null,
      requiresSubscription: await this.requiresSubscription(),
      isOwner: viewerId !== undefined && playlist.ownerId === viewerId,
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
    dto: { name: string; description?: string; coverUrl?: string; audioIds?: string[] },
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
    const added = dto.audioIds?.length
      ? await this.addItems(memberId, playlist.id, dto.audioIds)
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
   * Append slides at the end, in the order given.
   *
   * Keyed on the SLIDE, not the lesson: that is the id the client already holds
   * (course detail emits it on every slide) and the id the listening log speaks,
   * so an item and the sessions it produced line up.
   *
   * A slide already in the playlist is NOT an error: the bottom sheet hits that
   * case constantly (the member forgot), and a 409 there reads as a bug. Unknown,
   * unplayable, or archived slides are dropped and reported rather than failing
   * the whole call — one stale id from a client cache must not sink the request.
   */
  async addItems(memberId: string, playlistId: string, audioIds: string[]) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    const requested = [...new Set(audioIds)];
    if (requested.length === 0) throw badRequest(ERROR_CODES.PLAYLIST_ITEMS_REQUIRED);

    const resolved = await this.resolveAudioSlides(requested);
    const skipped = requested.filter((id) => !resolved.has(id));

    const existing = await prisma.playlistItem.findMany({
      where: { playlistId },
      select: { audioId: true, order: true },
    });
    const present = new Set(existing.map((e) => e.audioId));
    const toAdd = requested.filter((id) => resolved.has(id) && !present.has(id));

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
        data: toAdd.map((audioId) => ({
          playlistId,
          audioId,
          lessonId: resolved.get(audioId)!,
          order: nextOrder++,
        })),
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

  /**
   * slide id → owning lesson id, for the slides that exist and are playable.
   *
   * A slide id lives inside a JSON column, so there is no table to join and no
   * index to use: this unnests `slides_data` and matches. Raw SQL because Prisma
   * cannot express `jsonb_array_elements`. The catalogue is in the hundreds of
   * lessons, and this runs only on writes — if it ever shows up in a profile, the
   * fix is a generated column or a slide index table, not a cache.
   */
  private async resolveAudioSlides(audioIds: string[]): Promise<Map<string, string>> {
    if (audioIds.length === 0) return new Map();
    const rows = await prisma.$queryRaw<Array<{ lesson_id: string; audio_id: string }>>`
      SELECT l.id AS lesson_id, s->>'id' AS audio_id
      FROM course_lessons l, jsonb_array_elements(l.slides_data) s
      WHERE l.lesson_status = 'ACTIVE'
        AND s->>'type' = ANY (${PLAYABLE_SLIDE_TYPES as unknown as string[]})
        AND s->>'id' = ANY (${audioIds})
    `;
    return new Map(rows.map((r) => [r.audio_id, r.lesson_id]));
  }

  async removeItems(memberId: string, playlistId: string, audioIds: string[]) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    if (audioIds.length === 0) throw badRequest(ERROR_CODES.PLAYLIST_ITEMS_REQUIRED);
    const { count } = await prisma.playlistItem.deleteMany({
      where: { playlistId, audioId: { in: audioIds } },
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
  async reorder(memberId: string, playlistId: string, audioIds: string[]) {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);

    const rows = await prisma.playlistItem.findMany({
      where: { playlistId },
      orderBy: { order: 'asc' },
      select: { id: true, audioId: true },
    });
    const byAudio = new Map(rows.map((r) => [r.audioId, r.id]));
    const ordered = [
      ...audioIds.filter((id) => byAudio.has(id)),
      ...rows.map((r) => r.audioId).filter((id) => !audioIds.includes(id)),
    ];

    await prisma.$transaction(
      ordered.map((audioId, index) =>
        prisma.playlistItem.update({
          where: { id: byAudio.get(audioId)! },
          data: { order: index + 1 },
        }),
      ),
    );
    return { reordered: ordered.length };
  }

  // --- share -----------------------------------------------------------------

  /**
   * Switch sharing on, or rotate the link.
   *
   * The token is random, NOT derived from the id: a UUID v7 carries its own
   * creation timestamp and — more to the point — can never be withdrawn. A
   * separate nullable column is what makes "stop sharing" and "give me a new
   * link" possible at all.
   *
   * Minting twice without `rotate` returns the same link, so the share sheet is
   * safe to tap repeatedly.
   */
  async share(memberId: string, playlistId: string, rotate = false) {
    await this.assertAccess(memberId);
    const playlist = await this.ownedOrThrow(memberId, playlistId);

    const items = await prisma.playlistItem.count({ where: { playlistId } });
    // A link to an empty playlist is a dead end for whoever receives it.
    if (items === 0) throw badRequest(ERROR_CODES.PLAYLIST_ITEMS_REQUIRED);

    if (playlist.shareToken && !rotate) {
      return { shareToken: playlist.shareToken, sharedAt: playlist.sharedAt };
    }

    const updated = await prisma.playlist.update({
      where: { id: playlistId },
      data: {
        shareToken: randomBytes(SHARE_TOKEN_BYTES).toString('base64url'),
        sharedAt: new Date(),
        visibility: PLAYLIST_VISIBILITY.unlisted,
      },
    });
    return { shareToken: updated.shareToken!, sharedAt: updated.sharedAt };
  }

  /** Withdraw the link. Anyone holding it gets a 404 from the next fetch on. */
  async unshare(memberId: string, playlistId: string): Promise<void> {
    await this.assertAccess(memberId);
    await this.ownedOrThrow(memberId, playlistId);
    await prisma.playlist.update({
      where: { id: playlistId },
      data: { shareToken: null, sharedAt: null, visibility: PLAYLIST_VISIBILITY.private },
    });
  }

  /**
   * Copy a shared playlist into the caller's own library.
   *
   * Items are copied AS IS, locked ones included. `locked` is derived per read,
   * never stored, so an item the copier cannot play today unlocks by itself the
   * moment they subscribe — copying only what they own would drop those items
   * permanently, and they would never come back.
   *
   * Idempotent per (owner, source token): tapping save twice returns the same
   * copy instead of littering the library.
   */
  async saveFromShare(memberId: string, token: string) {
    await this.assertAccess(memberId);

    const source = await prisma.playlist.findUnique({ where: { shareToken: token } });
    if (!source || source.isBlocked || !source.shareToken) {
      throw notFound(ERROR_CODES.PLAYLIST_NOT_FOUND);
    }

    const existing = await prisma.playlist.findFirst({
      where: { ownerId: memberId, copiedFromToken: token },
    });
    if (existing) return { playlist: existing, created: false };

    await this.assertQuota(memberId);

    const items = await prisma.playlistItem.findMany({
      where: { playlistId: source.id },
      orderBy: { order: 'asc' },
      select: { audioId: true, lessonId: true },
    });

    const copy = await prisma.playlist.create({
      data: {
        ownerId: memberId,
        name: source.name,
        description: source.description,
        coverUrl: source.coverUrl,
        visibility: PLAYLIST_VISIBILITY.private,
        // Plain scalar, no FK: the source may be deleted or unshared later and
        // this copy must not care.
        copiedFromToken: token,
        items: {
          create: items.map((it, index) => ({
            audioId: it.audioId,
            lessonId: it.lessonId,
            order: index + 1,
          })),
        },
      },
    });

    return { playlist: copy, created: true };
  }

  // --- history (derived, never pre-aggregated) --------------------------------

  /**
   * Recently played, most recent first.
   *
   * Derived from `listening_session` rather than from a "playlist opened" event:
   * an open event is cheap to read but the number is junk — a mis-tap counts as
   * much as an hour of listening, and "top" then ranks whoever fumbled most.
   */
  async listRecent(memberId: string, limit = PLAYLIST_HISTORY_LIMIT): Promise<PlaylistHistoryRow[]> {
    const groups = await prisma.listeningSession.groupBy({
      by: ['playlistId'],
      where: {
        memberId,
        playlistId: { not: null },
        listenedSec: { gte: PLAYLIST_PLAYED_MIN_SEC },
      },
      _max: { startedAt: true },
      _sum: { listenedSec: true },
      orderBy: { _max: { startedAt: 'desc' } },
      // Over-fetch: some ids will be dropped as unreachable below.
      take: limit * 3,
    });
    return this.hydrateHistory(memberId, groups, limit);
  }

  /**
   * Most listened, by total seconds — not by number of opens, which is both
   * less honest and trivially inflated by opening and closing.
   */
  async listTop(
    memberId: string,
    rangeDays = PLAYLIST_TOP_RANGE_DAYS,
    limit = PLAYLIST_HISTORY_LIMIT,
  ): Promise<PlaylistHistoryRow[]> {
    const since = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);
    const groups = await prisma.listeningSession.groupBy({
      by: ['playlistId'],
      where: {
        memberId,
        playlistId: { not: null },
        listenedSec: { gte: PLAYLIST_PLAYED_MIN_SEC },
        startedAt: { gte: since },
      },
      _max: { startedAt: true },
      _sum: { listenedSec: true },
      orderBy: { _sum: { listenedSec: 'desc' } },
      take: limit * 3,
    });
    return this.hydrateHistory(memberId, groups, limit);
  }

  /**
   * Turn aggregated ids into playlists the member can actually open again.
   *
   * Ghost filtering is the whole job here. A playlist in the log may since have
   * been deleted, unshared, or blocked; without this the member taps a card and
   * gets a 404. Rows are dropped SILENTLY — rendering "no longer available"
   * would leak that the playlist existed and was just withdrawn, undoing the
   * point of withdrawing it. `listening_session.playlist_id` has no FK, so the
   * dangling ids are expected, not a data bug.
   */
  private async hydrateHistory(
    memberId: string,
    groups: Array<{
      playlistId: string | null;
      _max: { startedAt: Date | null };
      _sum: { listenedSec: number | null };
    }>,
    limit: number,
  ): Promise<PlaylistHistoryRow[]> {
    const ids = groups.map((g) => g.playlistId).filter((id): id is string => id !== null);
    if (ids.length === 0) return [];

    const rows = await prisma.playlist.findMany({
      where: {
        id: { in: ids },
        isBlocked: false,
        // Reachable = mine, or still shared. A copy the member saved is theirs
        // and is unaffected by anything the original owner does.
        OR: [{ ownerId: memberId }, { shareToken: { not: null } }],
      },
      include: { _count: { select: { items: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    return groups
      .flatMap((g) => {
        const playlist = g.playlistId ? byId.get(g.playlistId) : undefined;
        if (!playlist) return [];
        return [
          {
            playlist,
            lastPlayedAt: g._max.startedAt,
            totalListenedSec: g._sum.listenedSec ?? 0,
          },
        ];
      })
      .slice(0, limit);
  }
}
