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
  /** Verification blocks (id_verifications / liveness_checks / face_matches) sit
   *  at the top level of the pulled decision, but nested under `decision` in a
   *  webhook body — extractDocumentIdentity() accepts either. */
  decision?: Record<string, unknown>;
  id_verifications?: unknown;
  [key: string]: unknown;
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

export interface DiditDocumentIdentity {
  /** The document number as printed (for an Indonesian KTP: the NIK). */
  idNumber: string;
  /** Provider's own label for the document kind — stored verbatim, never mapped. */
  idType: string | null;
  /** Which payload field the number came from. Logged for provenance; the VALUE never is. */
  field: 'document_number' | 'personal_number';
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || t.toUpperCase() === 'N/A' ? null : t;
}

/**
 * Pull the document number + kind out of a Didit decision.
 *
 * Accepts the pulled decision (`id_verifications` at the top level) or a webhook
 * body (same block nested under `decision`), and tolerates the block being a bare
 * object instead of an array — the shape differs per workflow and we only ever
 * read it defensively.
 *
 * `document_number` wins over `personal_number`: on an Indonesian KTP the document
 * number IS the NIK, while `personal_number` is the optional MRZ field that is
 * frequently absent or a different identifier altogether. Returns null when the
 * workflow carries no ID-document step (liveness-only) or the number is missing —
 * callers must treat that as "leave the stored value alone", never as "clear it".
 */
export function extractDocumentIdentity(payload: unknown): DiditDocumentIdentity | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const nested = root.decision as Record<string, unknown> | undefined;
  const block = root.id_verifications ?? (nested ? nested.id_verifications : undefined);
  const entries = Array.isArray(block) ? block : block ? [block] : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const documentNumber = str(e.document_number);
    const personalNumber = str(e.personal_number);
    const idNumber = documentNumber ?? personalNumber;
    if (!idNumber) continue;
    return {
      idNumber,
      idType: str(e.document_type),
      field: documentNumber ? 'document_number' : 'personal_number',
    };
  }
  return null;
}
