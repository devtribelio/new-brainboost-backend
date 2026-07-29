import { prisma } from '@bb/db';
import type { Prisma } from '@prisma/client';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { PUSH_CHANNEL } from '@bb/common/mq/push-contract';
import { PUBLISHED_STATUS_FILTER } from '@bb/common/utils/post-status.util';
import { runConcurrent } from '@bb/common/utils/concurrency.util';
import { dayKey, toLocalDayWIB, wibHourInstant } from '@bb/common/utils/wib.util';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { NotificationProducer } from '../notification/notification.producer';
import { RecipientResolver } from '../notification/recipient.resolver';
import { fcmService } from '../notification/fcm.service';
import { ActionLabel, NotifGroup } from '../notification/action-labels';

/**
 * Default hour (WIB) the recap goes out. Runtime-overridable without a deploy via
 * `app_settings` key `notification.topicDigestHour` — marketing will want to move
 * this. Out-of-range or non-numeric values fall back to this constant.
 */
export const DIGEST_HOUR_WIB = 21;

/** Resolve the configured recap hour, rejecting anything outside 0-23. */
export async function resolveDigestHour(): Promise<number> {
  const raw = await settingsService.getNumber(
    SETTING_KEYS.notificationTopicDigestHour,
    DIGEST_HOUR_WIB,
  );
  if (!Number.isInteger(raw) || raw < 0 || raw > 23) {
    logger.warn(
      { configured: raw, fallback: DIGEST_HOUR_WIB },
      '[topic-digest] invalid notification.topicDigestHour — using default',
    );
    return DIGEST_HOUR_WIB;
  }
  return raw;
}

/** Max members pushed in parallel — protects the DB pool and FCM at the 21:00 spike. */
export const DIGEST_CONCURRENCY = 10;

const producer = new NotificationProducer();
const resolver = new RecipientResolver();

export interface TopicDigestResult {
  /** Set when the job ran before today's boundary and did nothing. */
  skipped?: 'before-boundary';
  digestDay?: string;
  windowStart?: Date;
  windowEnd?: Date;
  topics?: number;
  posts?: number;
  members?: number;
  notifications?: number;
  pushes?: number;
}

interface DigestEntry {
  topicId: string;
  topicName: string;
  networkId: string | null;
  count: number;
}

/**
 * Nightly recap: one push per member at 21:00 WIB summarising the new posts in
 * the topics they subscribe to — "9 post baru di Topic A" — instead of a push
 * per post as it happens.
 *
 * Shape of the run:
 *  - Window is the fixed 24h ending at 21:00 WIB **today**, so windows never
 *    overlap. A post made at 21:05 belongs to tomorrow's recap.
 *  - Self-guarding on the WIB clock: before the boundary it is a no-op. That
 *    makes the job safe on the existing hourly cron lane regardless of what
 *    timezone the scheduler daemon thinks it is in — nothing in this repo pins
 *    the server TZ, so the job must not trust the trigger's wall clock.
 *  - Idempotent per WIB day via `dedupeKey` (`topicDigest:<day>:<topic>:<member>`,
 *    a UNIQUE column). Later ticks the same day create nothing, and a member
 *    whose rows all deduped gets no second push.
 *  - Counts exclude the member's own posts, deleted/unpublished posts, and
 *    honour mutes on both the `topic` and the parent `network` scope.
 *
 * Rows are written per topic (so the feed stays granular and each entry can
 * deep-link into its topic) but the push is a single combined message — five
 * subscribed topics must not mean five pushes at 9pm.
 *
 * @param now     Reference instant; injectable so tests can pin the boundary.
 * @param hourWib Override the configured recap hour (tests; skips the settings read).
 */
export async function topicDigestNotifications(
  now: Date = new Date(),
  hourWib?: number,
): Promise<TopicDigestResult> {
  const hour = hourWib ?? (await resolveDigestHour());
  const wibDay = toLocalDayWIB(now);
  const windowEnd = wibHourInstant(wibDay, hour);

  if (now < windowEnd) {
    logger.debug({ now, hour, boundary: windowEnd }, '[topic-digest] before cutoff — nothing to do');
    return { skipped: 'before-boundary' };
  }

  const windowStart = new Date(windowEnd.getTime() - 86_400_000);
  const digestDay = dayKey(wibDay);

  const posts = await prisma.post.findMany({
    where: {
      topicId: { not: null },
      isDeleted: false,
      publishStatus: PUBLISHED_STATUS_FILTER,
      createdAt: { gte: windowStart, lt: windowEnd },
    },
    select: { topicId: true, authorId: true },
  });

  if (posts.length === 0) {
    logger.info({ digestDay, windowStart, windowEnd }, '[topic-digest] no posts in window');
    return { digestDay, windowStart, windowEnd, topics: 0, posts: 0, members: 0, notifications: 0, pushes: 0 };
  }

  // topicId -> { total, byAuthor } so a member's own posts can be subtracted.
  const perTopic = new Map<string, { total: number; byAuthor: Map<string, number> }>();
  for (const p of posts) {
    const topicId = p.topicId!;
    let bucket = perTopic.get(topicId);
    if (!bucket) {
      bucket = { total: 0, byAuthor: new Map() };
      perTopic.set(topicId, bucket);
    }
    bucket.total += 1;
    bucket.byAuthor.set(p.authorId, (bucket.byAuthor.get(p.authorId) ?? 0) + 1);
  }

  const topics = await prisma.topic.findMany({
    where: { id: { in: [...perTopic.keys()] }, isActive: true },
    select: { id: true, name: true, networkId: true },
  });

  // memberId -> entries, one per topic with a non-zero count for that member.
  const perMember = new Map<string, DigestEntry[]>();

  for (const topic of topics) {
    const bucket = perTopic.get(topic.id)!;

    const subscribers = await resolver.resolveForTopic(topic.id);
    if (subscribers.length === 0) continue;

    const muteScopes: Array<{ scope: string; refId: string }> = [{ scope: 'topic', refId: topic.id }];
    if (topic.networkId) muteScopes.push({ scope: 'network', refId: topic.networkId });
    const recipients = await resolver.filterNotMuted(subscribers, muteScopes);

    for (const memberId of recipients) {
      const own = bucket.byAuthor.get(memberId) ?? 0;
      const count = bucket.total - own;
      if (count <= 0) continue; // only their own posts — nothing new for them
      const list = perMember.get(memberId) ?? [];
      list.push({ topicId: topic.id, topicName: topic.name, networkId: topic.networkId, count });
      perMember.set(memberId, list);
    }
  }

  let notifications = 0;
  let queued = 0;
  let pushes = 0;

  // Queue mode is the durable path: the push is handed to SQS via the outbox.
  // With no push queue provisioned we fall back to sending in-process, which
  // keeps dev and the pre-provisioning window working.
  const queueMode = Boolean(env.sqs.pushQueueUrl);

  const members = [...perMember.entries()];
  await runConcurrent(members, DIGEST_CONCURRENCY, async ([memberId, entries]) => {
    try {
      const keyed = entries.map((entry) => ({
        entry,
        dedupeKey: `topicDigest:${digestDay}:${entry.topicId}:${memberId}`,
      }));
      const existing = await prisma.notification.findMany({
        where: { dedupeKey: { in: keyed.map((k) => k.dedupeKey) } },
        select: { dedupeKey: true },
      });
      const done = new Set(existing.map((r) => r.dedupeKey));
      const fresh = keyed.filter((k) => !done.has(k.dedupeKey));
      if (fresh.length === 0) return; // already digested today

      const total = fresh.reduce((sum, k) => sum + k.entry.count, 0);
      const single = fresh.length === 1;
      const title = single
        ? `${total} post baru di ${fresh[0].entry.topicName}`
        : `${total} post baru di ${fresh.length} topic yang kamu ikuti`;
      const body = single ? undefined : fresh.map((k) => `${k.entry.topicName} (${k.entry.count})`).join(', ');
      const data = {
        type: ActionLabel.TopicDigest,
        digestDay,
        topicIds: fresh.map((k) => k.entry.topicId).join(','),
        totalPosts: String(total),
      };

      // Rows AND the push job commit together. If this crashes, nothing is
      // written and the next run redoes the member — the failure mode where
      // rows exist but the push was lost forever is not reachable.
      const ops: Prisma.PrismaPromise<unknown>[] = fresh.map(({ entry, dedupeKey }) =>
        prisma.notification.create({
          data: {
            memberId,
            type: ActionLabel.TopicDigest,
            notifGroup: NotifGroup.General,
            networkId: entry.networkId,
            title: `${entry.count} post baru di ${entry.topicName}`,
            payload: {
              refTable: 'topic',
              refId: entry.topicId,
              topicId: entry.topicId,
              networkId: entry.networkId,
              postCount: entry.count,
              digestDay,
            },
            dedupeKey,
          },
        }),
      );

      if (queueMode) {
        ops.push(
          prisma.notificationOutbox.create({
            data: {
              type: ActionLabel.TopicDigest,
              channel: PUSH_CHANNEL,
              priority: 'normal',
              refId: memberId,
              payload: { memberId, title, ...(body ? { body } : {}), data },
            },
          }),
        );
      }

      await prisma.$transaction(ops);
      notifications += fresh.length;

      if (queueMode) {
        queued += 1;
        return;
      }

      if (!fcmService.isEnabled()) return; // rows still land in the in-app feed
      await fcmService.sendToMember(memberId, { title, body, data });
      pushes += 1;
    } catch (err) {
      logger.error({ err, memberId, digestDay }, '[topic-digest] member digest failed');
    }
  });

  logger.info(
    { digestDay, windowStart, windowEnd, topics: topics.length, posts: posts.length, members: members.length, notifications, pushes },
    '[topic-digest] done',
  );

  return {
    digestDay,
    windowStart,
    windowEnd,
    topics: topics.length,
    posts: posts.length,
    members: members.length,
    notifications,
    pushes,
  };
}
