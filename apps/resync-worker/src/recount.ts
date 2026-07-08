/* eslint-disable no-console */
/**
 * One-shot recount of the denormalised social counters on posts + comments.
 *
 *   pnpm resync:recount
 *
 * WHY: resync writes comments/likes DIRECTLY (createMany/upsert), bypassing the app's
 * increment/decrement of the cached counters — so `count_comment`/`count_like`/
 * `count_replies` drift (understated / zero) for migrated + resynced content. The app
 * READS these columns (post/comment serializers) and SORTS the feed by `count_like`, so
 * stale values are user-visible. This recomputes them from the actual rows, matching the
 * exact semantics the app maintains (see comment.service.ts):
 *   posts.count_comment = top-level comments (parent_id IS NULL, not deleted)
 *   posts.count_replies = replies         (parent_id IS NOT NULL, not deleted)
 *   posts.count_like    = post_likes rows
 *   comments.count_replies = direct replies to the comment (not deleted)
 *   comments.count_like    = comment_likes rows
 *
 * Idempotent + self-healing (also fixes app-side drift). Run when the worker is idle /
 * traffic is low — a concurrent app like/comment may be off by one until the next run.
 * Set-based (one aggregate scan per source table), safe to re-run any time.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [resync:recount] ${msg}`);
}

// [label, sql] — run in order inside one transaction. Reset-then-set so rows with no
// children/likes land on 0.
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

async function main() {
  const started = Date.now();
  log('recomputing denormalised post/comment counters…');
  await prisma.$transaction(
    async (tx) => {
      for (const [label, sql] of STATEMENTS) {
        const n = await tx.$executeRawUnsafe(sql);
        log(`${label}: ${n} rows`);
      }
    },
    { timeout: 600_000 },
  );
  log(`DONE in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((err) => {
    console.error('[resync:recount] fatal', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
