import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { signSumsubRequest } from '@bb/common/services/sumsub-signature';

// ---------------------------------------------------------------------------
// Sumsub REST client (KYC provider for the affiliate disbursement gate).
//
// Every request carries X-App-Token + X-App-Access-Ts + X-App-Access-Sig
// (HMAC-SHA256 over ts+method+path+body — see sumsub-signature.ts). The app
// token/secret NEVER leave the backend; mobile only ever receives the
// short-lived SDK access token from generateSdkAccessToken().
// Docs: https://docs.sumsub.com/reference/get-started-with-api
// ---------------------------------------------------------------------------

export function isSumsubConfigured(): boolean {
  return !!(env.sumsub.appToken && env.sumsub.secretKey);
}

async function sumsubRequest<T>(
  method: 'GET' | 'POST',
  pathWithQuery: string,
  body?: Record<string, unknown>,
): Promise<T> {
  if (!isSumsubConfigured()) {
    throw new Error('SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY not configured');
  }
  const ts = Math.floor(Date.now() / 1000);
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const sig = signSumsubRequest(env.sumsub.secretKey, ts, method, pathWithQuery, bodyStr);

  const res = await fetch(`${env.sumsub.baseUrl}${pathWithQuery}`, {
    method,
    headers: {
      'X-App-Token': env.sumsub.appToken,
      'X-App-Access-Ts': String(ts),
      'X-App-Access-Sig': sig,
      ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
    },
    body: bodyStr,
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (json.description as string) || `Sumsub request failed (HTTP ${res.status})`;
    logger.error({ status: res.status, path: pathWithQuery, body: json }, '[sumsub] request failed');
    const err = new Error(message) as Error & { status?: number; code?: unknown };
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json as T;
}

export interface SumsubApplicant {
  id: string;
  externalUserId: string;
  review?: { reviewStatus?: string };
}

/**
 * Create an applicant bound to our member UUID (externalUserId).
 * Sumsub dedupes on externalUserId per level: a 409 means the applicant
 * already exists — callers should then resolve it via getApplicantByExternalId.
 */
export async function createApplicant(
  externalUserId: string,
  levelName = env.sumsub.levelName,
): Promise<SumsubApplicant> {
  return sumsubRequest<SumsubApplicant>(
    'POST',
    `/resources/applicants?levelName=${encodeURIComponent(levelName)}`,
    { externalUserId },
  );
}

export async function getApplicantByExternalId(externalUserId: string): Promise<SumsubApplicant> {
  return sumsubRequest<SumsubApplicant>(
    'GET',
    `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`,
  );
}

/**
 * Reset an applicant: wipes the previous verification result so the applicant
 * returns to "init". Required for re-KYC — without it a still-GREEN applicant
 * would let a webhook replay / SDK re-run flip the member back to APPROVED with
 * NO fresh verification. After reset the next SDK run must re-capture documents.
 * Docs: POST /resources/applicants/{applicantId}/reset
 */
export async function resetApplicant(applicantId: string): Promise<void> {
  await sumsubRequest('POST', `/resources/applicants/${encodeURIComponent(applicantId)}/reset`);
}

export interface SumsubAccessToken {
  token: string;
  userId: string;
}

/**
 * Short-lived access token consumed by the Sumsub Mobile/Web SDK.
 * Valid for exactly one applicant; safe to hand to the client.
 */
export async function generateSdkAccessToken(
  externalUserId: string,
  levelName = env.sumsub.levelName,
  ttlInSecs = env.sumsub.tokenTtlSeconds,
): Promise<SumsubAccessToken> {
  return sumsubRequest<SumsubAccessToken>('POST', '/resources/accessTokens/sdk', {
    userId: externalUserId,
    levelName,
    ttlInSecs,
  });
}
