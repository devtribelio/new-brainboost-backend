import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  ERROR_CODES,
  ERROR_MESSAGES,
  messageFor,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
} from '@bb/common/exceptions';
import { buildApp } from '../src/app';

/**
 * Locks both halves of the envelope contract (docs/api-envelope.md: "error.code
 * for branching, error.message for display").
 *
 * `code` assertions exist so a reword can never silently break the mobile
 * client. The message assertions exist for the opposite reason: the client
 * displays `error.message` verbatim, so an English string slipping back into the
 * catalog is a user-visible bug, and these tests are what catch it.
 */

/**
 * Codes whose response never reaches a human — they answer Xendit / Didit /
 * RevenueCat / the ingestion caller, whose dashboards are English. Everything
 * NOT listed here must be Indonesian.
 */
const SERVER_TO_SERVER = new Set<string>([
  ERROR_CODES.INGEST_CREDENTIAL_INVALID,
  ERROR_CODES.INGEST_EVENT_ID_REQUIRED,
  ERROR_CODES.INGEST_TYPE_INVALID,
  ERROR_CODES.INGEST_REFUND_REFERENCE_REQUIRED,
  ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
  ERROR_CODES.WEBHOOK_TOKEN_INVALID,
  ERROR_CODES.WEBHOOK_AUTH_MISSING,
  ERROR_CODES.WEBHOOK_AUTH_INVALID,
]);

describe('error code catalog', () => {
  it('every key equals its value, so a code can never be silently aliased', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('has no duplicate codes', () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('every code has display copy', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(messageFor(code), `missing copy for ${code}`).toBeTruthy();
      expect(messageFor(code).trim(), `blank copy for ${code}`).not.toBe('');
    }
  });
});

describe('error copy is displayable Indonesian', () => {
  // Words that only appear in English copy. A hit means an untranslated string
  // reached the catalog and would be shown to a user as-is.
  const ENGLISH = /\b(the|not|found|required|invalid|must|already|please|your|expired|try)\b/i;

  it('no user-facing message is left in English', () => {
    const offenders = Object.entries(ERROR_MESSAGES)
      .filter(([code]) => !SERVER_TO_SERVER.has(code))
      .filter(([, msg]) => ENGLISH.test(msg))
      .map(([code, msg]) => `${code}: ${msg}`);
    expect(offenders).toEqual([]);
  });

  it('no message leaks a template placeholder or trailing period', () => {
    for (const [code, msg] of Object.entries(ERROR_MESSAGES)) {
      expect(msg, `${code} interpolates a value`).not.toMatch(/\$\{|\{\{/);
      if (!SERVER_TO_SERVER.has(code)) {
        expect(msg, `${code} ends with a period`).not.toMatch(/\.$/);
      }
    }
  });
});

describe('factories bind status, code and copy together', () => {
  it('each factory sets its own status and pulls copy from the catalog', () => {
    const cases = [
      [badRequest(ERROR_CODES.OTP_EXPIRED), 400, ERROR_CODES.OTP_EXPIRED],
      [unauthorized(ERROR_CODES.SESSION_REVOKED), 401, ERROR_CODES.SESSION_REVOKED],
      [forbidden(ERROR_CODES.NETWORK_MEMBER_MUTED), 403, ERROR_CODES.NETWORK_MEMBER_MUTED],
      [notFound(ERROR_CODES.POST_NOT_FOUND), 404, ERROR_CODES.POST_NOT_FOUND],
    ] as const;
    for (const [err, status, code] of cases) {
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.message).toBe(messageFor(code));
    }
  });

  it('passes details through untouched', () => {
    const err = badRequest(ERROR_CODES.POST_CONTENT_TOO_LONG, { max: 5000 });
    expect(err.details).toEqual({ max: 5000 });
  });
});

describe('exception classes carry an explicit code', () => {
  it('defaults to the status-derived code when none is given', () => {
    expect(new BadRequestException('x').code).toBe(ERROR_CODES.BAD_REQUEST);
    expect(new UnauthorizedException('x').code).toBe(ERROR_CODES.UNAUTHORIZED);
    expect(new ForbiddenException('x').code).toBe(ERROR_CODES.FORBIDDEN);
    expect(new NotFoundException('x').code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('passes an explicit code through on every class', () => {
    expect(new BadRequestException('x', undefined, ERROR_CODES.OTP_EXPIRED).code).toBe(
      'OTP_EXPIRED',
    );
    expect(new UnauthorizedException('x', undefined, ERROR_CODES.SESSION_REVOKED).code).toBe(
      'SESSION_REVOKED',
    );
    expect(new ForbiddenException('x', undefined, ERROR_CODES.TRANSACTION_NOT_OWNED).code).toBe(
      'TRANSACTION_NOT_OWNED',
    );
    expect(new NotFoundException('x', undefined, ERROR_CODES.TRANSACTION_NOT_FOUND).code).toBe(
      'TRANSACTION_NOT_FOUND',
    );
  });

  it('keeps the status independent of the code', () => {
    // Same condition reported from a 400 and a 404 route must still be one code
    // for the client; the status stays whatever the throwing class chose.
    expect(new BadRequestException('x', undefined, ERROR_CODES.PRODUCT_NOT_FOUND).status).toBe(400);
    expect(new NotFoundException('x', undefined, ERROR_CODES.PRODUCT_NOT_FOUND).status).toBe(404);
  });
});

describe('auth guard emits branchable codes', () => {
  const PROTECTED = '/api/member/account/profile/info';

  it('missing Authorization header → BEARER_TOKEN_MISSING', async () => {
    const res = await request(buildApp()).get(PROTECTED);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.BEARER_TOKEN_MISSING);
  });

  it('unparseable bearer token → ACCESS_TOKEN_INVALID', async () => {
    const res = await request(buildApp())
      .get(PROTECTED)
      .set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ERROR_CODES.ACCESS_TOKEN_INVALID);
  });
});

describe('error responses are always the JSON envelope', () => {
  // Regression: error.middleware.ts used to branch on `originalUrl.startsWith('/admin')`
  // and call res.render('admin/error') — a leftover from apps/admin-ejs (removed
  // 2026-07). mobile-api registers no view engine, so that render threw and
  // Express' finalhandler replied with an HTML page (carrying a full stack trace
  // outside production) instead of the envelope.
  it('an /admin path still gets JSON, not a rendered HTML page', async () => {
    const res = await request(buildApp()).get('/admin/anything');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(res.text).not.toContain('<!DOCTYPE html>');
  });
});
