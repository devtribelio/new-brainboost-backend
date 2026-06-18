/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-shot data migration: posts + their derivatives (comments, post-likes,
 * comment-likes) for the TWO BrainBoost networks only — Timeline (legacy 23410)
 * and Education (legacy 25136).
 *
 * Why a dedicated script (not the global migrate-from-legacy phases)
 * -----------------------------------------------------------------
 * The global `posts` phase in migrate-from-legacy.ts is NOT network-scoped (it
 * pulls every tribelio post) AND it never sets `Post.networkId` — it only links
 * topicId, dropping the network association the mobile feed needs. It also skips
 * title / postType / embedUrl / excerpt / engagedAt / publishStatus.
 *
 * This script is scoped to the 2 BrainBoost networks and fills `networkId` +
 * the richer fields. Legacy `post` and `comment` both carry `network_id`, so we
 * scope those directly; `like` has no network_id, so likes are scoped via the
 * legacy post/comment ids gathered in this run.
 *
 * Order: run AFTER create-bb-networks.ts (needs the coded network rows),
 * AFTER members are migrated, and AFTER topics exist (for topicId linkage).
 * Idempotent: posts/comments upsert by `legacyId`; likes createMany +
 * skipDuplicates (rely on @@unique). Safe to re-run.
 *
 *   pnpm tsx scripts/migrate-network-posts.ts
 */
import 'dotenv/config';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const NETWORK_LEGACY_IDS = [23410, 25136]; // BBTIMELN, BBEDUCAT
const IN_CHUNK = 1000;

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function nonEmpty(value: any): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v === '' ? null : v;
}

function date(value: any): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Build a legacyId -> new uuid map for any model exposing legacyId. */
async function buildMap(model: { findMany: (a: any) => Promise<any[]> }): Promise<Map<number, string>> {
  const rows = await model.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true },
  });
  return new Map(rows.map((r) => [r.legacyId as number, r.id as string]));
}

async function migratePosts(
  legacy: Connection,
  networkMap: Map<number, string>,
  memberMap: Map<number, string>,
  topicMap: Map<number, string>,
): Promise<number[]> {
  log('posts: fetching (scoped to 2 networks)');
  const [rows] = await legacy.query<RowDataPacket[]>(
    `SELECT post_id, network_id, member_id, topic_id, title, post_type, content,
            embed_url, excerpt, image_url, enganged_at, publish_status, created
       FROM post
      WHERE network_id IN (?) AND status=1 AND is_active=1 AND member_id IS NOT NULL
      ORDER BY post_id`,
    [NETWORK_LEGACY_IDS],
  );
  log(`posts: legacy rows = ${rows.length}`);

  const scopedPostIds: number[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows as any[]) {
    const authorId = memberMap.get(r.member_id);
    const networkId = networkMap.get(r.network_id);
    if (!authorId || !networkId) {
      skipped++;
      continue;
    }
    const legacyId = r.post_id as number;
    const topicId = r.topic_id ? topicMap.get(r.topic_id) ?? null : null;
    const imgRaw = nonEmpty(r.image_url);
    const imageUrls = imgRaw
      ? imgRaw.split(/[,;\n]/).map((u) => u.trim()).filter((u) => u.length > 0)
      : [];
    const fields = {
      authorId,
      networkId,
      topicId,
      title: nonEmpty(r.title),
      postType: nonEmpty(r.post_type),
      content: nonEmpty(r.content) ?? '',
      excerpt: nonEmpty(r.excerpt),
      embedUrl: nonEmpty(r.embed_url),
      imageUrls,
      publishStatus: (nonEmpty(r.publish_status) ?? 'PUBLISHED').toUpperCase(),
      engagedAt: date(r.enganged_at) ?? null,
      isDeleted: false,
      createdAt: date(r.created) ?? new Date(),
    };
    const before = await prisma.post.findUnique({ where: { legacyId }, select: { id: true } });
    await prisma.post.upsert({
      where: { legacyId },
      create: { legacyId, ...fields },
      update: fields,
    });
    if (before) updated++;
    else created++;
    scopedPostIds.push(legacyId);
  }

  log(`posts: DONE created=${created} updated=${updated} skipped=${skipped}`);
  return scopedPostIds;
}

async function migrateComments(
  legacy: Connection,
  memberMap: Map<number, string>,
  postMap: Map<number, string>,
): Promise<number[]> {
  const base = `SELECT comment_id, post_id, member_id, reply_id, content, created
     FROM comment
    WHERE network_id IN (?) AND status=1 AND is_active=1 AND post_id IS NOT NULL AND member_id IS NOT NULL`;

  // Pass 1: top-level (reply_id null/0)
  log('comments: pass 1 — top-level');
  const [topRows] = await legacy.query<RowDataPacket[]>(
    `${base} AND (reply_id IS NULL OR reply_id=0) ORDER BY comment_id`,
    [NETWORK_LEGACY_IDS],
  );
  let p1 = 0;
  for (const r of topRows as any[]) {
    const postId = postMap.get(r.post_id);
    const authorId = memberMap.get(r.member_id);
    if (!postId || !authorId) continue;
    const legacyId = r.comment_id as number;
    const fields = {
      postId,
      authorId,
      parentId: null as string | null,
      content: nonEmpty(r.content) ?? '',
      isDeleted: false,
      createdAt: date(r.created) ?? new Date(),
    };
    await prisma.comment.upsert({ where: { legacyId }, create: { legacyId, ...fields }, update: fields });
    p1++;
  }
  log(`comments pass 1: ${p1} upserted`);

  // Pass 2: replies (parent resolved via commentMap)
  log('comments: pass 2 — replies');
  const commentMap = await buildMap(prisma.comment);
  const [replyRows] = await legacy.query<RowDataPacket[]>(
    `${base} AND reply_id IS NOT NULL AND reply_id<>0 ORDER BY comment_id`,
    [NETWORK_LEGACY_IDS],
  );
  let p2 = 0;
  for (const r of replyRows as any[]) {
    const postId = postMap.get(r.post_id);
    const authorId = memberMap.get(r.member_id);
    const parentId = commentMap.get(r.reply_id);
    if (!postId || !authorId || !parentId) continue;
    const legacyId = r.comment_id as number;
    const fields = {
      postId,
      authorId,
      parentId,
      content: nonEmpty(r.content) ?? '',
      isDeleted: false,
      createdAt: date(r.created) ?? new Date(),
    };
    await prisma.comment.upsert({ where: { legacyId }, create: { legacyId, ...fields }, update: fields });
    p2++;
  }
  log(`comments pass 2: ${p2} upserted`);

  return [...(topRows as any[]), ...(replyRows as any[])].map((r) => r.comment_id as number);
}

async function migratePostLikes(
  legacy: Connection,
  scopedPostIds: number[],
  memberMap: Map<number, string>,
  postMap: Map<number, string>,
) {
  log(`post-likes: scoped to ${scopedPostIds.length} posts`);
  let inserted = 0;
  for (const ids of chunk(scopedPostIds, IN_CHUNK)) {
    if (!ids.length) continue;
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT post_id, member_id, created FROM \`like\`
        WHERE status=1 AND post_id IN (?) AND (comment_id IS NULL OR comment_id=0) AND member_id IS NOT NULL`,
      [ids],
    );
    const data = (rows as any[])
      .map((r) => {
        const postId = postMap.get(r.post_id);
        const memberId = memberMap.get(r.member_id);
        if (!postId || !memberId) return null;
        return { postId, memberId, createdAt: date(r.created) ?? new Date() };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.postLike.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
  }
  log(`post-likes: DONE inserted=${inserted}`);
}

async function migrateCommentLikes(
  legacy: Connection,
  scopedCommentIds: number[],
  memberMap: Map<number, string>,
  commentMap: Map<number, string>,
) {
  log(`comment-likes: scoped to ${scopedCommentIds.length} comments`);
  let inserted = 0;
  for (const ids of chunk(scopedCommentIds, IN_CHUNK)) {
    if (!ids.length) continue;
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT comment_id, member_id, created FROM \`like\`
        WHERE status=1 AND comment_id IN (?) AND comment_id<>0 AND member_id IS NOT NULL`,
      [ids],
    );
    const data = (rows as any[])
      .map((r) => {
        const commentId = commentMap.get(r.comment_id);
        const memberId = memberMap.get(r.member_id);
        if (!commentId || !memberId) return null;
        return { commentId, memberId, createdAt: date(r.created) ?? new Date() };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.commentLike.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
  }
  log(`comment-likes: DONE inserted=${inserted}`);
}

async function main() {
  // Resolve the 2 networks by legacyId (stamped by create-bb-networks.ts).
  const nets = await prisma.network.findMany({
    where: { legacyId: { in: NETWORK_LEGACY_IDS } },
    select: { id: true, legacyId: true, code: true },
  });
  const networkMap = new Map<number, string>(nets.map((n) => [n.legacyId as number, n.id]));
  const missing = NETWORK_LEGACY_IDS.filter((id) => !networkMap.has(id));
  if (missing.length) {
    throw new Error(
      `Networks not found for legacyId(s) ${missing.join(', ')}. Run create-bb-networks.ts first.`,
    );
  }
  log(`networks: ${nets.map((n) => `${n.code}=${n.legacyId}`).join(', ')}`);

  log('building member/topic maps');
  const memberMap = await buildMap(prisma.member);
  const topicMap = await buildMap(prisma.topic);
  log(`members=${memberMap.size} topics=${topicMap.size}`);

  const legacy = await connectLegacyDb();
  try {
    // scopedPostIds / commentLegacyIds are the legacy ids that belong to the 2
    // networks — used to scope likes (the `like` table has no network_id).
    const scopedPostIds = await migratePosts(legacy, networkMap, memberMap, topicMap);
    const postMap = await buildMap(prisma.post); // refresh after upserts

    const commentLegacyIds = await migrateComments(legacy, memberMap, postMap);
    const commentMap = await buildMap(prisma.comment);

    await migratePostLikes(legacy, scopedPostIds, memberMap, postMap);
    await migrateCommentLikes(legacy, commentLegacyIds, memberMap, commentMap);
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
  log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
