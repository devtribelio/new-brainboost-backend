import { Xendit } from 'xendit-node';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';

let cached: Xendit | null = null;

export function getXenditClient(): Xendit {
  if (cached) return cached;
  if (!env.xendit.secretKey) {
    throw new Error('XENDIT_SECRET_KEY not configured');
  }
  cached = new Xendit({ secretKey: env.xendit.secretKey });
  logger.debug('[xendit] SDK client initialized');
  return cached;
}

export function resetXenditClient(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Disbursement (legacy /disbursements API — money OUT to a member's bank).
//
// The xendit-node v7 SDK only ships the newer v2 "Payout" API. We deliberately
// call the legacy v1 Disbursement endpoint directly to match the field shape the
// platform already used (TBXendit::createDisbursementXendit) and keep callback
// parity. Auth: HTTP Basic, secretKey as username + BLANK password.
// Docs: https://developers.xendit.co/api-reference/#create-disbursement
// ---------------------------------------------------------------------------

const XENDIT_DISBURSEMENT_URL = 'https://api.xendit.co/disbursements';

export interface CreateDisbursementInput {
  externalId: string; // our idempotency key; Xendit dedupes on (account, external_id)
  amount: number; // net amount paid to the member (IDR)
  bankCode: string; // Xendit bank code, e.g. "BCA", "MANDIRI"
  accountHolderName: string;
  accountNumber: string;
  description?: string;
}

export interface CreateDisbursementResult {
  id: string; // Xendit disbursement id
  status: string; // PENDING | COMPLETED | FAILED (callback drives the final state)
  raw: Record<string, unknown>;
}

/** HTTP Basic header for the secret key (username) + blank password. */
function basicAuthHeader(secretKey: string): string {
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
}

export async function createDisbursement(
  input: CreateDisbursementInput,
): Promise<CreateDisbursementResult> {
  const secretKey = env.xendit.secretKey;
  if (!secretKey) {
    throw new Error('XENDIT_SECRET_KEY not configured');
  }

  const body = {
    external_id: input.externalId,
    amount: input.amount,
    bank_code: input.bankCode,
    account_holder_name: input.accountHolderName,
    account_number: input.accountNumber,
    description: input.description ?? `Disbursement ${input.externalId}`,
  };

  const res = await fetch(XENDIT_DISBURSEMENT_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(secretKey),
      'Content-Type': 'application/json',
      // Idempotency on Xendit's side: a retried POST with the same key never double-pays.
      'X-IDEMPOTENCY-KEY': input.externalId,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const message =
      (json.message as string) ||
      (json.error_code as string) ||
      `Xendit disbursement failed (HTTP ${res.status})`;
    logger.error(
      { status: res.status, externalId: input.externalId, body: json },
      '[xendit] disbursement create failed',
    );
    throw new Error(message);
  }

  return {
    id: String(json.id ?? ''),
    status: String(json.status ?? ''),
    raw: json,
  };
}
