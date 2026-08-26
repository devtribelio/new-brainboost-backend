import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  extractDocumentIdentity,
  getSessionDecision,
  isDiditConfigured,
} from '@bb/common/services/didit.client';

/**
 * One-shot backfill of members.kyc_id_number / kyc_id_type for members verified
 * through Didit before the webhook path started capturing the document number.
 *
 * Selection is keyed on `kyc_provider_ref IS NOT NULL`, NOT on `kyc_source = 'DIDIT'`:
 * an admin decision taken in the backoffice rewrites kyc_source to MANUAL while
 * leaving the session ref intact, so filtering on the source would silently skip
 * every manually-reviewed Didit member — the common case, since decisions are made
 * in the backoffice. A member whose ref was cleared by a re-KYC reset cannot be
 * backfilled at all (the session is gone); those are counted and reported.
 *
 * Usage: pnpm kyc:backfill-didit-id [--dry-run]
 */
const DRY_RUN = process.argv.includes('--dry-run');
/** Politeness gap between provider calls — this is a bulk walk over one API key. */
const DELAY_MS = 250;

const prisma = new PrismaClient();

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[backfill-didit-id]${DRY_RUN ? ' [dry-run]' : ''} ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!isDiditConfigured()) {
    throw new Error('DIDIT_API_KEY / DIDIT_WORKFLOW_ID not configured');
  }

  const rows = await prisma.member.findMany({
    where: { kycProviderRef: { not: null }, kycIdNumber: null },
    select: { id: true, kycProviderRef: true, kycStatus: true, kycSource: true },
    orderBy: { createdAt: 'asc' },
  });

  // Reported, not processed: the re-KYC reset cleared their session ref, so there is
  // nothing left to pull. They fill in on their next verification attempt.
  const unreachable = await prisma.member.count({
    where: { kycProviderRef: null, kycIdNumber: null, kycSource: { in: ['DIDIT', 'MANUAL'] } },
  });

  log(`candidates=${rows.length} unreachable(no provider ref)=${unreachable}`);

  let filled = 0;
  let noNumber = 0;
  let failed = 0;

  for (const [i, m] of rows.entries()) {
    const sessionId = m.kycProviderRef!;
    try {
      const identity = extractDocumentIdentity(await getSessionDecision(sessionId));
      if (!identity) {
        noNumber++;
        log(`no document number: member=${m.id} status=${m.kycStatus} source=${m.kycSource}`);
      } else {
        if (!DRY_RUN) {
          await prisma.member.update({
            where: { id: m.id },
            data: {
              kycIdNumber: identity.idNumber,
              ...(identity.idType ? { kycIdType: identity.idType } : {}),
            },
          });
        }
        filled++;
        // Never log the number itself — only where it came from.
        log(`filled member=${m.id} field=${identity.field} idType=${identity.idType ?? '-'}`);
      }
    } catch (e) {
      failed++;
      log(`FAILED member=${m.id} session=${sessionId}: ${(e as Error).message}`);
    }
    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  log(
    `DONE filled=${filled} noNumber=${noNumber} failed=${failed} unreachable=${unreachable}` +
      (DRY_RUN ? ' (nothing written)' : ''),
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error('[backfill-didit-id] fatal:', e);
  await prisma.$disconnect();
  process.exit(1);
});
