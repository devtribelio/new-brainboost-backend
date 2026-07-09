/* eslint-disable no-console */
/**
 * Recount the denormalised social counters on posts + comments from the actual rows.
 *
 *   pnpm resync:recount            # standalone one-shot
 *
 * Also invoked automatically at the end of a resync run when the `posts` syncer ran
 * (see core.ts) — resync writes comments/likes DIRECTLY, bypassing the app's
 * increment/decrement of these cached counters, and the app READS them (serializers) and
 * SORTS the feed by count_like, so they must be rebuilt. Matches the app's exact semantics
 * (comment.service.ts): posts.count_comment = top-level comments, posts.count_replies =
 * replies, is_deleted=false. Set-based (one aggregate scan per source), idempotent.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// [label, sql] — reset-then-set so rows with no children/likes land on 0.
const STATEMENTS: [string, string][] = [
  ['posts: reset', `UPDATE "posts" SET "count_comment" = 0, "count_replies" = 0, "count_like" = 0`],
  [
    'posts: comment + replies',
    `UPDATE "posts" p SET "count_comment" = a.cc, "count_replies" = a.cr
       FROM (
         SELECT "post_id",
                count(*) FILTER (WHERE "parent_id" IS NULL)     AS cc,
                count(*) FILTER (WHERE "parent_id" IS NOT NULL)  AS cr
           FROM "comments" WHERE "is_deleted" = false
          GROUP BY "post_id"
       ) a
      WHERE a."post_id" = p.id`,
  ],
  [
    'posts: like',
    `UPDATE "posts" p SET "count_like" = a.n
       FROM (SELECT "post_id", count(*) AS n FROM "post_likes" GROUP BY "post_id") a
      WHERE a."post_id" = p.id`,
  ],
  ['comments: reset', `UPDATE "comments" SET "count_like" = 0, "count_replies" = 0`],
  [
    'comments: replies',
    `UPDATE "comments" c SET "count_replies" = a.n
       FROM (
         SELECT "parent_id", count(*) AS n
           FROM "comments" WHERE "parent_id" IS NOT NULL AND "is_deleted" = false
          GROUP BY "parent_id"
       ) a
      WHERE a."parent_id" = c.id`,
  ],
  [
    'comments: like',
    `UPDATE "comments" c SET "count_like" = a.n
       FROM (SELECT "comment_id", count(*) AS n FROM "comment_likes" GROUP BY "comment_id") a
      WHERE a."comment_id" = c.id`,
  ],
];

/** Recompute all five post/comment counters. Reusable from the CLI and the worker run. */
export async function recountCounters(prisma: PrismaClient, log: (msg: string) => void): Promise<void> {
  const started = Date.now();
  await prisma.$transaction(
    async (tx) => {
      for (const [, sql] of STATEMENTS) await tx.$executeRawUnsafe(sql);
    },
    { timeout: 600_000 },
  );
  log(`recount: post/comment counters rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function main() {
  const prisma = new PrismaClient({ log: ['warn', 'error'] });
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] [resync:recount] ${m}`);
  try {
    log('recomputing denormalised post/comment counters…');
    await recountCounters(prisma, log);
    log('DONE');
  } finally {
    await prisma.$disconnect();
  }
}

// run as CLI only when invoked directly (not when imported by core.ts)
if (require.main === module) {
  main().catch((err) => {
    console.error('[resync:recount] fatal', err);
    process.exit(1);
  });
}
