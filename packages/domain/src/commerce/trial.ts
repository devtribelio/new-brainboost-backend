import { prisma } from '@bb/db';

/**
 * Free-trial voucher helpers, shared by the three listeners that react to
 * `commerce.payment.success` (enrollment grant, notification, email).
 *
 * Deliberately NOT carried on the event: an optional field would be read as
 * "not a trial" by any emitter that forgot to set it, and that failure is
 * silent. A PK lookup per listener — only when the order carried a voucher at
 * all — is cheap enough to prefer over a shape that can drift.
 */

export interface TrialGrant {
  voucherId: string;
  trialDays: number;
}

/** Non-null only for a `type='TRIAL'` voucher with a usable duration. */
export async function loadTrialGrant(voucherId: string): Promise<TrialGrant | null> {
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { id: true, type: true, trialDays: true },
  });
  if (v?.type !== 'TRIAL' || v.trialDays == null || v.trialDays <= 0) return null;
  return { voucherId: v.id, trialDays: v.trialDays };
}

export function trialExpiresAt(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

const ID_MONTHS = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * "27 Agustus 2026", read in WIB.
 *
 * The offset is applied because timestamps are stored tz-less in app-clock UTC,
 * so formatting them raw shows the previous day for anything that happened after
 * 17:00 WIB — i.e. a member who starts a trial in the evening would be told it
 * ends a day earlier than it does. The stored instant is untouched; only the
 * label the member reads is shifted.
 */
export function formatDateWib(d: Date): string {
  const wib = new Date(d.getTime() + WIB_OFFSET_MS);
  return `${wib.getUTCDate()} ${ID_MONTHS[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`;
}
