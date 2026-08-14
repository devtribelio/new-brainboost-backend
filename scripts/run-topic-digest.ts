import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isUuid } from '../packages/common/src/utils/uuid.util';
import { topicDigest } from '../packages/domain/src/jobs/topic-digest';

/**
 * Manual trigger for the nightly topic digest — QA only.
 *
 * The scheduled path fires once a day at `notification.digestHour`, and ships
 * with `notification.digestEnabled = false`, so there is no way to see the job
 * work without either waiting for that hour or forcing it. This forces it.
 *
 *   pnpm digest:run                        # dry run, everybody — prints what WOULD be sent
 *   pnpm digest:run --member=<uuid|email>  # dry run, one member
 *   pnpm digest:run --member=<…> --send    # really push, to that member only
 *   pnpm digest:run --send                 # really push, TO EVERY ELIGIBLE MEMBER
 *
 * Dry run is the default on purpose: a real run pushes to phones and stamps
 * `members.last_topic_digest_at`, which marks those posts as already reported —
 * the night's scheduled digest then finds nothing left to say. That stamp is not
 * reversible from here, so sending is opt-in and `--member` is the safe way to
 * test on production.
 *
 * Ignores `digestEnabled` and the configured hour (that is the point). It does
 * NOT bypass the per-member rules: a member with nothing unread, or whose topics
 * are all muted, still gets nothing.
 */

const args = process.argv.slice(2);
const send = args.includes('--send');
const memberArg = args.find((a) => a.startsWith('--member='))?.slice('--member='.length);

const unknown = args.filter((a) => a !== '--send' && !a.startsWith('--member='));
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`);
  console.error('Usage: pnpm digest:run [--member=<uuid|email>] [--send]');
  process.exit(1);
}

const prisma = new PrismaClient();

async function resolveMemberId(input: string): Promise<string> {
  // Shape-check first: `members.id` is `@db.Uuid`, so querying it with an email
  // makes Postgres reject the cast and surfaces a Prisma internal error instead
  // of falling through to the email lookup.
  if (isUuid(input)) {
    const byId = await prisma.member.findUnique({ where: { id: input }, select: { id: true } });
    if (byId) return byId.id;
    throw new Error(`No member with id ${input}`);
  }
  const byEmail = await prisma.member.findFirst({ where: { email: input }, select: { id: true } });
  if (byEmail) return byEmail.id;
  throw new Error(`No member with email ${input}`);
}

async function main(): Promise<void> {
  const memberId = memberArg ? await resolveMemberId(memberArg) : undefined;

  if (send && !memberId) {
    console.warn('⚠️  --send without --member: pushing to EVERY eligible member.');
  }

  const result = await topicDigest(new Date(), { force: true, dryRun: !send, memberId });

  console.log(
    JSON.stringify(
      {
        mode: send ? 'SENT' : 'dry-run',
        scope: memberId ?? 'all members',
        candidates: result.candidates,
        pushed: result.pushed,
        silentAllMuted: result.silentAllMuted,
      },
      null,
      2,
    ),
  );

  if (result.preview) {
    if (result.preview.length === 0) {
      console.log('\nNothing to send — no unread topic posts for the selected scope.');
    } else {
      console.log(`\nWould send ${result.preview.length} push(es):\n`);
      for (const p of result.preview) {
        console.log(`  → ${p.memberId}\n    ${p.title}\n    ${p.body}\n    ${JSON.stringify(p.data)}\n`);
      }
      console.log('Re-run with --send to actually deliver these.');
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
