import { Prisma } from '@prisma/client';
import { prisma } from '@bb/db';
import { logger } from '@bb/common/config/logger';
import { settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { NotificationProducer } from '../notification/notification.producer';
import { ActionLabel } from '../notification/action-labels';
import { MuteScope } from '../notification/mute-scope';

/**
 * Nightly topic digest: one push per member summarising the topic posts they have
 * NOT read yet.
 *
 * Counts unread `newPost` rows rather than raw posts on purpose. A member who kept
 * up all day has nothing unread, so they get no push at all — no special-casing —
 * and the copy stays honest: "9 post baru" means 9 they have not seen. Raw post
 * counts would tell an up-to-date member about posts they already read.
 *
 * Writes NO notification rows: the per-post rows already exist, and the digest is a
 * summary of them. It is also exempt from the unopened-push budget (see
 * `NotificationProducer.sendPushOnly`).
 *
 * The TRIGGER is the hourly `bb-cron` tick; this job decides whether the current
 * hour is the configured one. That is what makes the send time editable from
 * `app_settings` with no redeploy and no PM2 change.
 */

// Legacy + app clocks are WIB everywhere else in this repo, and WIB has no DST,
// so a fixed offset is exact — no tz database needed.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export const DIGEST_HOUR_DEFAULT = 21;
/** Members processed per push batch — bounds concurrent FCM calls on a big sweep. */
const BATCH_SIZE = 100;

export interface TopicDigestResult {
  skipped?: 'disabled' | 'wrong-hour';
  candidates: number;
  pushed: number;
  silentAllMuted: number;
  /** Present on a dry run: what WOULD have been sent, without sending it. */
  preview?: DigestPush[];
}

export interface TopicDigestOptions {
  /**
   * Run regardless of `notification.digestEnabled` and the configured hour.
   * For the manual trigger only — a digest is otherwise unverifiable outside
   * its one scheduled hour of the day, with the setting shipping `false`.
   */
  force?: boolean;
  /**
   * Build the plan and return it, but send nothing and stamp nothing. Leaves
   * `lastTopicDigestAt` untouched, so a preview cannot eat the real run's
   * watermark — which is the whole hazard of testing this job for real.
   */
  dryRun?: boolean;
  /**
   * Restrict the whole sweep to one member. For the manual trigger: it makes a
   * real send testable on production without pushing to everybody, and confines
   * the watermark it burns to that one account.
   */
  memberId?: string;
}

export interface DigestPush {
  memberId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface DigestPlan {
  /** Members with unread topic activity — stamped whether or not a push goes out. */
  candidates: string[];
  pushes: DigestPush[];
  /** Had activity, but every topic of it was muted. */
  silentAllMuted: number;
}

interface UnreadRow {
  member_id: string;
  topic_id: string;
  unread: bigint;
}

export function wibHour(now: Date): number {
  return new Date(now.getTime() + WIB_OFFSET_MS).getUTCHours();
}

/** "Mindset", "Bisnis, dan 1 topik lain", "Mindset, Bisnis, dan 3 topik lain". */
export function joinTopicNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} dan ${names[1]}`;
  const head = names.slice(0, 2).join(', ');
  return `${head}, dan ${names.length - 2} topik lain`;
}

/**
 * Everything except the sending: read unread state, drop muted topics, build one
 * payload per member. Split out so the shape of a digest is testable without FCM
 * credentials — the send itself is a no-op when FCM is disabled.
 */
export async function collectDigests(memberId?: string): Promise<DigestPlan> {
  // One pass over every member's unread topic posts. Prisma's groupBy cannot join,
  // and the per-member watermark lives on `members`, so this is raw by necessity.
  // `memberId` narrows the sweep to one account (manual trigger); the tagged
  // template still parameterises it, so it is not string-interpolated SQL.
  const memberFilter = memberId
    ? Prisma.sql`AND n.member_id = ${memberId}::uuid`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<UnreadRow[]>`
    SELECT n.member_id, n.topic_id, COUNT(*) AS unread
    FROM notifications n
    JOIN members m ON m.id = n.member_id
    WHERE n.type = ${ActionLabel.NewPost}
      AND n.read_at IS NULL
      AND n.topic_id IS NOT NULL
      AND m.is_active
      AND m.notifications_enabled
      AND (m.last_topic_digest_at IS NULL OR n.created_at > m.last_topic_digest_at)
      ${memberFilter}
    GROUP BY n.member_id, n.topic_id
  `;
  if (rows.length === 0) return { candidates: [], pushes: [], silentAllMuted: 0 };

  const perMember = new Map<string, Array<{ topicId: string; unread: number }>>();
  for (const r of rows) {
    const list = perMember.get(r.member_id) ?? [];
    list.push({ topicId: r.topic_id, unread: Number(r.unread) });
    perMember.set(r.member_id, list);
  }
  const memberIds = [...perMember.keys()];
  const topicIds = [...new Set(rows.map((r) => r.topic_id))];

  const [topics, mutes] = await Promise.all([
    prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }),
    prisma.notificationMute.findMany({
      where: { memberId: { in: memberIds }, scope: MuteScope.Topic, refId: { in: topicIds } },
      select: { memberId: true, refId: true },
    }),
  ]);
  const topicName = new Map(topics.map((t) => [t.id, t.name]));
  const muted = new Set(mutes.map((m) => `${m.memberId}:${m.refId}`));

  const pushes: DigestPush[] = [];
  let silentAllMuted = 0;

  for (const memberId of memberIds) {
    // Muted topics drop out BEFORE counting, so the total never advertises posts
    // from a topic the member asked to be quiet about.
    const active = perMember
      .get(memberId)!
      .filter((t) => !muted.has(`${memberId}:${t.topicId}`) && topicName.has(t.topicId))
      .sort((a, b) => b.unread - a.unread);

    if (active.length === 0) {
      silentAllMuted++;
      continue;
    }

    const total = active.reduce((sum, t) => sum + t.unread, 0);
    const names = active.map((t) => topicName.get(t.topicId)!);

    // One topic keeps the precise deep link; several have no single target, so the
    // push opens Tribe and the member picks from the per-topic rows waiting there.
    pushes.push(
      active.length === 1
        ? {
            memberId,
            title: names[0]!,
            body: `Ada ${total} post baru di ${names[0]}`,
            data: {
              type: ActionLabel.TopicDigest,
              refTable: 'topic',
              refId: active[0]!.topicId,
              topicName: names[0]!,
              postCount: String(total),
            },
          }
        : {
            memberId,
            title: 'Tribe',
            body: `Ada ${total} post baru di ${joinTopicNames(names)}`,
            data: {
              type: ActionLabel.TribeDigest,
              postCount: String(total),
              topicCount: String(active.length),
            },
          },
    );
  }

  return { candidates: memberIds, pushes, silentAllMuted };
}

export async function topicDigest(
  now: Date = new Date(),
  opts: TopicDigestOptions = {},
): Promise<TopicDigestResult> {
  const empty: TopicDigestResult = { candidates: 0, pushed: 0, silentAllMuted: 0 };

  // The scheduled path takes both gates; the manual trigger (`force`) skips them,
  // otherwise the job would be unverifiable outside its one hour a day.
  if (!opts.force) {
    const [enabled, hour] = await Promise.all([
      settingsService.getBoolean(SETTING_KEYS.notificationDigestEnabled, false),
      settingsService.getNumber(SETTING_KEYS.notificationDigestHour, DIGEST_HOUR_DEFAULT),
    ]);
    if (!enabled) return { ...empty, skipped: 'disabled' };
    if (wibHour(now) !== hour) return { ...empty, skipped: 'wrong-hour' };
  }

  const plan = await collectDigests(opts.memberId);
  if (plan.candidates.length === 0) return empty;

  // Return the plan without sending or stamping. Stamping is the destructive
  // half: it would mark these posts as reported and the real run that night
  // would find nothing left to say.
  if (opts.dryRun) {
    return {
      candidates: plan.candidates.length,
      pushed: 0,
      silentAllMuted: plan.silentAllMuted,
      preview: plan.pushes,
    };
  }

  const producer = new NotificationProducer();
  let pushed = 0;
  for (let i = 0; i < plan.pushes.length; i += BATCH_SIZE) {
    const batch = plan.pushes.slice(i, i + BATCH_SIZE);
    const sent = await Promise.all(
      batch.map((p) =>
        producer.sendPushOnly(p.memberId, { title: p.title, body: p.body, data: p.data }),
      ),
    );
    pushed += sent.filter(Boolean).length;
  }

  // Every evaluated member is stamped, including the all-muted ones: without it
  // their unread rows would be re-counted every night forever.
  await prisma.member.updateMany({
    where: { id: { in: plan.candidates } },
    data: { lastTopicDigestAt: now },
  });

  logger.info(
    {
      candidates: plan.candidates.length,
      pushed,
      silentAllMuted: plan.silentAllMuted,
      hour: wibHour(now),
      forced: opts.force ?? false,
      memberId: opts.memberId,
    },
    '[topic-digest] sweep done',
  );
  return { candidates: plan.candidates.length, pushed, silentAllMuted: plan.silentAllMuted };
}
