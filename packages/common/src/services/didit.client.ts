import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';

// ---------------------------------------------------------------------------
// Didit REST client (KYC provider for the affiliate disbursement gate).
//
// Auth is a single `x-api-key` header — no per-request HMAC signing. The API key
// NEVER leaves the backend; mobile only ever receives the session token / hosted
// URL from createSession(). Didit is session-per-attempt: every verification is a
// fresh session (no persistent applicant), so re-KYC just mints a new session.
// Note: Didit returns 403 (not 401) for auth failures.
// Docs: https://docs.didit.me/integration/api-full-flow
// ---------------------------------------------------------------------------

export function isDiditConfigured(): boolean {
  return !!(env.didit.apiKey && env.didit.workflowId);
}

async function diditRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  if (!isDiditConfigured()) {
    throw new Error('DIDIT_API_KEY / DIDIT_WORKFLOW_ID not configured');
  }
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const res = await fetch(`${env.didit.baseUrl}${path}`, {
    method,
    headers: {
      'x-api-key': env.didit.apiKey,
      Accept: 'application/json',
      ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
    },
    body: bodyStr,
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (json.detail as string) ||
      (json.message as string) ||
      `Didit request failed (HTTP ${res.status})`;
    logger.error({ status: res.status, path, body: json }, '[didit] request failed');
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export interface DiditSession {
  /** Unique UUID for this verification session. */
  session_id: string;
  /** 12-char URL-safe token the SDK / hosted flow uses to authorize the end user. */
  session_token: string;
  /** Hosted verification URL (webview / redirect fallback). */
  url: string;
  /** Initial status, "Not Started". */
  status: string;
}

/**
 * Create a verification session bound to our member UUID (echoed back as
 * `vendor_data` in every webhook, so we can correlate without a lookup table).
 * Returns the session id (stored as kycProviderRef), the SDK token, and the
 * hosted URL — mobile picks the native SDK (session_token) or webview (url).
 */
export async function createSession(vendorData: string): Promise<DiditSession> {
  return diditRequest<DiditSession>('POST', '/v3/session/', {
    workflow_id: env.didit.workflowId,
    vendor_data: vendorData,
    ...(env.didit.callbackUrl ? { callback: env.didit.callbackUrl } : {}),
  });
}

export interface DiditDecision {
  session_id: string;
  status: string;
  vendor_data?: string;
  decision?: Record<string, unknown>;
}

/**
 * Fetch the full decision for a session (reconciliation / debugging). The webhook
 * is the primary status driver; this is a pull fallback when a webhook is missed.
 */
export async function getSessionDecision(sessionId: string): Promise<DiditDecision> {
  return diditRequest<DiditDecision>(
    'GET',
    `/v3/session/${encodeURIComponent(sessionId)}/decision/`,
  );
}
