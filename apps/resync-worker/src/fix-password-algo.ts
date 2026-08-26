/* eslint-disable no-console */
/**
 * One-off (idempotent) repair of `members.password_algo` for rows whose stored algo
 * disagrees with the SHAPE of `password_hash`.
 *
 *   pnpm resync:fix-password-algo [--dry-run]
 *
 * WHY. Every legacy writer (migrate-members, migrate-from-legacy, ensureMember,
 * identity split) used to stamp `passwordAlgo: legacyPassword ? 'legacy' : 'social'`
 * without looking at the hash. Legacy is md5 almost everywhere, but ~440 of the 462k
 * legacy passwords are PHP `password_hash()` bcrypt digests. `'legacy'` is the md5
 * alias in AuthService.verifyPassword, so those members get md5(plaintext) compared
 * against `$2y$…` — never a match, permanent lockout with a correct password.
 *
 * Only rows whose hash shape is UNAMBIGUOUS are touched, and `social` is left alone
 * (its hash is a random uuid-pair sentinel that must never authenticate). The new
 * algo comes from the same detectPasswordAlgo() the writers now use.
 *
 * Does NOT bump updated_at: this corrects metadata about an unchanged hash, and a bump
 * would trip the members-syncer touch-gate (updatedAt > legacySyncedAt) and freeze the
 * row's profile against legacy forever.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { detectPasswordAlgo } from '@bb/common/utils/password-algo.util';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const dryRun = process.argv.includes('--dry-run');

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [resync:fix-password-algo] ${msg}`);
}

async function main() {
  // `social` rows are excluded outright rather than left to the shape check: their hash
  // is a random uuid-pair sentinel, and letting a social-only account acquire a real algo
  // is the one outcome that must be impossible.
  const rows = await prisma.member.findMany({
    where: { passwordAlgo: { not: 'social' } },
    select: { id: true, passwordAlgo: true, passwordHash: true },
  });

  const wrong = rows
    .map((r) => ({ id: r.id, from: r.passwordAlgo, to: detectPasswordAlgo(r.passwordHash) }))
    .filter((r) => r.to !== 'social' && r.to !== r.from);

  const byPair = new Map<string, string[]>();
  for (const r of wrong) {
    const k = `${r.from} -> ${r.to}`;
    byPair.set(k, [...(byPair.get(k) ?? []), r.id]);
  }

  log(`scanned ${rows.length} member(s), ${wrong.length} mismatched`);
  for (const [pair, ids] of byPair) log(`  ${pair}: ${ids.length}`);
  if (wrong.length === 0 || dryRun) {
    log(dryRun ? 'dry-run — nothing written' : 'nothing to fix');
    return;
  }

  for (const [pair, ids] of byPair) {
    const to = pair.split(' -> ')[1];
    const n = await prisma.$executeRaw`
      UPDATE "members" SET "password_algo" = ${to}
       WHERE "id" = ANY(${ids}::uuid[])`;
    log(`  ${pair}: updated ${n}`);
  }
  log('done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
