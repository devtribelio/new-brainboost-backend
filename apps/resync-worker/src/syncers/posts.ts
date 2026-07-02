/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Posts syncer — incremental port of migrate-network-posts.ts (the 2 BrainBoost networks).
 * Covers posts → comments → replies → post-likes → comment-likes in one pass, sharing a
 * single combined watermark (each sub-query fetches everything with updated>since, so one
 * max watermark is safe).
 *
 * KEYS  post/comment upsert by legacyId; likes have no legacyId → createMany + skipDuplicates
 *       on their composite uniques.
 * GAPS  (logged) post/comment hard-deletes that fall out of the status=1/is_active=1 filter,
 *       and legacy un-likes (hard DELETE of a `like` row) do NOT propagate. See docs §3.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { emptyStats, type Stats, type Syncer, type SyncerCtx } from '../types';
import { maxWatermark, nonEmpty, sinceBound, toDate } from '../util';

const NETWORK_LEGACY_IDS = [23410, 25136]; // BB-TIMELINE, BB-EDUCATION
const IN_CHUNK = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function buildMap(model: { findMany: (a: any) => Promise<any[]> }): Promise<Map<number, string>> {
  const rows = await model.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  return new Map(rows.map((r) => [r.legacyId as number, r.id as string]));
}

export const postsSyncer: Syncer = {
  name: 'posts',
  async run(ctx: SyncerCtx): Promise<Stats> {
    const stats = emptyStats();
    const since = sinceBound(ctx.since);
    let watermark = ctx.since;

    const nets = await ctx.prisma.network.findMany({
      where: { legacyId: { in: NETWORK_LEGACY_IDS } },
      select: { id: true, legacyId: true },
    });
    const networkMap = new Map<number, string>(nets.map((n) => [n.legacyId as number, n.id]));
    if (networkMap.size < NETWORK_LEGACY_IDS.length) {
      ctx.log('WARN: BB networks not found — run create-bb-networks first; skipping posts');
      return stats;
    }
    const topicMap = await buildMap(ctx.prisma.topic);

    // 1) posts
    const [postRows] = await ctx.legacy.query<RowDataPacket[]>(
      `SELECT post_id, network_id, member_id, topic_id, title, post_type, content,
              embed_url, excerpt, image_url, enganged_at, publish_status, created,
              COALESCE(\`updated\`, \`created\`) AS wm
         FROM post
        WHERE network_id IN (?) AND status=1 AND is_active=1 AND member_id IS NOT NULL
          AND COALESCE(\`updated\`, \`created\`) > ?
        ORDER BY post_id`,
      [NETWORK_LEGACY_IDS, since],
    );
    for (const r of postRows as any[]) {
      stats.scanned += 1;
      watermark = maxWatermark(watermark, toDate(r.wm));
      const authorId = await ctx.ensureMember(Number(r.member_id));
      const networkId = networkMap.get(Number(r.network_id));
      if (!authorId || !networkId) {
        stats.skipped += 1;
        continue;
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        continue;
      }
      const imgRaw = nonEmpty(r.image_url);
      const imageUrls = imgRaw ? imgRaw.split(/[,;\n]/).map((u) => u.trim()).filter(Boolean) : [];
      const fields = {
        authorId,
        networkId,
        topicId: r.topic_id ? topicMap.get(Number(r.topic_id)) ?? null : null,
        title: nonEmpty(r.title),
        postType: nonEmpty(r.post_type),
        content: nonEmpty(r.content) ?? '',
        excerpt: nonEmpty(r.excerpt),
        embedUrl: nonEmpty(r.embed_url),
        imageUrls,
        publishStatus: (nonEmpty(r.publish_status) ?? 'PUBLISHED').toUpperCase(),
        engagedAt: toDate(r.enganged_at),
        isDeleted: false,
        createdAt: toDate(r.created) ?? new Date(),
      };
      try {
        await ctx.prisma.post.upsert({
          where: { legacyId: Number(r.post_id) },
          create: { legacyId: Number(r.post_id), ...fields },
          update: fields,
        });
        stats.upserted += 1;
      } catch {
        stats.errors += 1;
      }
    }

    // 2) comments (two-pass: top-level, then replies). Build map after each pass.
    const commentBase = `SELECT comment_id, post_id, member_id, reply_id, content, created,
            COALESCE(\`updated\`, \`created\`) AS wm
       FROM comment
      WHERE network_id IN (?) AND status=1 AND is_active=1 AND post_id IS NOT NULL AND member_id IS NOT NULL
        AND COALESCE(\`updated\`, \`created\`) > ?`;

    const upsertComment = async (r: any, postMap: Map<number, string>, commentMap: Map<number, string>) => {
      stats.scanned += 1;
      watermark = maxWatermark(watermark, toDate(r.wm));
      const postId = postMap.get(Number(r.post_id));
      const authorId = await ctx.ensureMember(Number(r.member_id));
      const isReply = r.reply_id && Number(r.reply_id) !== 0;
      const parentId = isReply ? commentMap.get(Number(r.reply_id)) ?? null : null;
      if (!postId || !authorId || (isReply && !parentId)) {
        stats.skipped += 1;
        return;
      }
      if (ctx.dryRun) {
        stats.upserted += 1;
        return;
      }
      const fields = {
        postId,
        authorId,
        parentId,
        content: nonEmpty(r.content) ?? '',
        isDeleted: false,
        createdAt: toDate(r.created) ?? new Date(),
      };
      try {
        await ctx.prisma.comment.upsert({
          where: { legacyId: Number(r.comment_id) },
          create: { legacyId: Number(r.comment_id), ...fields },
          update: fields,
        });
        stats.upserted += 1;
      } catch {
        stats.errors += 1;
      }
    };

    let postMap = await buildMap(ctx.prisma.post);
    const [topComments] = await ctx.legacy.query<RowDataPacket[]>(
      `${commentBase} AND (reply_id IS NULL OR reply_id=0) ORDER BY comment_id`,
      [NETWORK_LEGACY_IDS, since],
    );
    let commentMap = await buildMap(ctx.prisma.comment);
    for (const r of topComments as any[]) await upsertComment(r, postMap, commentMap);

    commentMap = await buildMap(ctx.prisma.comment); // refresh so replies resolve new parents
    const [replyComments] = await ctx.legacy.query<RowDataPacket[]>(
      `${commentBase} AND reply_id IS NOT NULL AND reply_id<>0 ORDER BY comment_id`,
      [NETWORK_LEGACY_IDS, since],
    );
    for (const r of replyComments as any[]) await upsertComment(r, postMap, commentMap);

    // 3) likes (new likes only — un-likes are hard deletes, not propagated). Watermarked,
    // Scoped to BB posts/comments by their legacy ids (the `like` table has no network_id,
    // so we filter SQL-side by post_id/comment_id IN the BB sets — NOT a full-table scan).
    postMap = await buildMap(ctx.prisma.post);
    commentMap = await buildMap(ctx.prisma.comment);
    if (!ctx.dryRun) {
      // post-likes
      for (const ids of chunk([...postMap.keys()], IN_CHUNK)) {
        if (!ids.length) continue;
        const [rows] = await ctx.legacy.query<RowDataPacket[]>(
          `SELECT post_id, member_id, created, COALESCE(\`updated\`, \`created\`) AS wm
             FROM \`like\`
            WHERE status=1 AND member_id IS NOT NULL AND (comment_id IS NULL OR comment_id=0)
              AND post_id IN (?) AND COALESCE(\`updated\`, \`created\`) > ?`,
          [ids, since],
        );
        const data: any[] = [];
        for (const r of rows as any[]) {
          watermark = maxWatermark(watermark, toDate(r.wm));
          const postId = postMap.get(Number(r.post_id));
          const memberId = ctx.resolveMember(Number(r.member_id));
          if (postId && memberId) data.push({ postId, memberId, createdAt: toDate(r.created) ?? new Date() });
        }
        if (data.length) stats.upserted += (await ctx.prisma.postLike.createMany({ data, skipDuplicates: true })).count;
      }
      // comment-likes
      for (const ids of chunk([...commentMap.keys()], IN_CHUNK)) {
        if (!ids.length) continue;
        const [rows] = await ctx.legacy.query<RowDataPacket[]>(
          `SELECT comment_id, member_id, created, COALESCE(\`updated\`, \`created\`) AS wm
             FROM \`like\`
            WHERE status=1 AND member_id IS NOT NULL AND comment_id<>0
              AND comment_id IN (?) AND COALESCE(\`updated\`, \`created\`) > ?`,
          [ids, since],
        );
        const data: any[] = [];
        for (const r of rows as any[]) {
          watermark = maxWatermark(watermark, toDate(r.wm));
          const commentId = commentMap.get(Number(r.comment_id));
          const memberId = ctx.resolveMember(Number(r.member_id));
          if (commentId && memberId) data.push({ commentId, memberId, createdAt: toDate(r.created) ?? new Date() });
        }
        if (data.length) stats.upserted += (await ctx.prisma.commentLike.createMany({ data, skipDuplicates: true })).count;
      }
    }

    if (watermark && !ctx.dryRun) await ctx.checkpoint(watermark);
    return stats;
  },
};
