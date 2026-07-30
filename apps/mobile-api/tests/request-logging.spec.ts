import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { logger } from '@bb/common/config/logger';
import { env } from '@bb/common/config/env';
import { requestLogger, REQUEST_ID_HEADER } from '@bb/common/middlewares/request-logger.middleware';
import {
  getRequestContext,
  resolveRequestId,
  setRequestContext,
} from '@bb/common/config/request-context';
import { captureLogs, type CapturedLine } from './helpers/capture-logs';

// LOG_HTTP defaults off under NODE_ENV=test (keeps suite output readable), so the
// access-log assertions below flip the resolved flag on for this file only.
// `env` is read once at import, hence the direct mutation rather than process.env.
const originalLogHttp = env.log.http;
const originalLogBody = env.log.httpBody;
const originalLogIncoming = env.log.httpIncoming;

type Line = CapturedLine & {
  requestId?: string;
  userId?: string;
  status?: number;
  durationMs?: number;
  route?: string;
  path?: string;
  handler?: string;
  errorCode?: string;
  slow?: boolean;
  query?: Record<string, unknown>;
  password?: string;
  body?: unknown;
};

let captured: Line[];

function buildTestApp() {
  const app = express();
  app.use(requestLogger);
  // Mirrors app.ts: the verify hook keeps the raw bytes, which is what the body
  // logger reads (see rawJsonBody).
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/context', (_req, res) => {
    const ctx = getRequestContext();
    res.json({ requestId: ctx?.requestId, method: ctx?.method, path: ctx?.path });
  });

  app.get('/correlated', (_req, res) => {
    // Stand-in for a @bb/domain service log: plain `logger`, no request plumbing.
    logger.info({ step: 'service-work' }, 'service.did.something');
    res.json({ ok: true });
  });

  app.get(
    '/guarded',
    // Stand-in for authGuard, which enriches the context the same way.
    (_req, _res, next) => {
      setRequestContext({ userId: 'member-uuid-1' });
      next();
    },
    (_req, res) => {
      logger.info('service.for.user');
      res.json({ ok: true });
    },
  );

  app.post('/echo', (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    '/dto',
    // Stand-in for validateDto, which replaces req.body with a whitelisted DTO
    // instance — dropping any property the DTO does not declare.
    (req, _res, next) => {
      req.body = { known: (req.body as Record<string, unknown>).known };
      next();
    },
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  app.get(
    '/dto-query',
    // Stand-in for validateDto(Dto, 'query'): replaces req.query with a
    // transformed, whitelisted instance — coerced types, unknown params gone.
    (req, _res, next) => {
      req.query = { page: 2 } as unknown as typeof req.query;
      next();
    },
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/boom', () => {
    throw new Error('kaboom');
  });

  return app;
}

let app: express.Express;

beforeAll(() => {
  env.log.http = true;
  // Set explicitly, not assumed from the NODE_ENV default: `pnpm test` runs with
  // --no-file-parallelism, so the `env` singleton is shared across spec files and
  // whatever ran before us may have left it flipped.
  env.log.httpBody = false;
  env.log.httpIncoming = false;
  captured = captureLogs();
  app = buildTestApp();
});

afterAll(() => {
  env.log.http = originalLogHttp;
  env.log.httpBody = originalLogBody;
  env.log.httpIncoming = originalLogIncoming;
});

function lines(msg: string): Line[] {
  return captured.filter((l) => l.msg === msg);
}

describe('resolveRequestId', () => {
  it('reuses a well-formed inbound id so logs join up across services', () => {
    expect(resolveRequestId('abc-123_def:456')).toBe('abc-123_def:456');
  });

  it('takes the first value when the header arrives as an array', () => {
    expect(resolveRequestId(['first-id-value', 'second'])).toBe('first-id-value');
  });

  it.each([
    ['too short', 'short'],
    ['unsafe chars (log injection)', 'bad id\nlevel=error'],
    ['over the 64-char cap', 'x'.repeat(65)],
    ['absent', undefined],
  ])('mints a fresh uuid when the inbound id is %s', (_label, input) => {
    const id = resolveRequestId(input);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toBe(input);
  });
});

describe('requestLogger', () => {
  it('echoes a generated request id in the response header', async () => {
    const res = await request(app).get('/ping').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(REQUEST_ID_HEADER.toLowerCase()).toBe('x-request-id');
  });

  it('propagates a caller-supplied X-Request-Id end to end', async () => {
    const res = await request(app)
      .get('/context')
      .set('X-Request-Id', 'inbound-trace-0001')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('inbound-trace-0001');
    // The handler sees the same id through AsyncLocalStorage.
    expect(res.body).toMatchObject({
      requestId: 'inbound-trace-0001',
      method: 'GET',
      path: '/context',
    });
  });

  it('logs one response line with status, duration and route', async () => {
    await request(app).get('/ping').set('X-Request-Id', 'trace-response-1').expect(200);

    const line = lines('http.response').find((l) => l.requestId === 'trace-response-1');
    expect(line).toBeDefined();
    expect(line?.status).toBe(200);
    expect(typeof line?.durationMs).toBe('number');
    expect(line?.level).toBe(30); // info
  });

  it('correlates a plain `logger` call from the service layer with the request', async () => {
    await request(app).get('/correlated').set('X-Request-Id', 'trace-service-1').expect(200);

    const serviceLine = lines('service.did.something').find(
      (l) => l.requestId === 'trace-service-1',
    );
    // This is the whole point of the mixin: the service never touched the
    // request, yet its log line carries the correlation id and the path.
    expect(serviceLine).toBeDefined();
    expect(serviceLine?.path).toBe('/correlated');
  });

  it('carries the authenticated userId on both the service and response lines', async () => {
    await request(app).get('/guarded').set('X-Request-Id', 'trace-user-1').expect(200);

    const serviceLine = lines('service.for.user').find((l) => l.requestId === 'trace-user-1');
    const responseLine = lines('http.response').find((l) => l.requestId === 'trace-user-1');
    expect(serviceLine?.userId).toBe('member-uuid-1');
    expect(responseLine?.userId).toBe('member-uuid-1');
  });

  it('logs 5xx at error level', async () => {
    await request(app).get('/boom').set('X-Request-Id', 'trace-error-1').expect(500);

    const line = lines('http.response').find((l) => l.requestId === 'trace-error-1');
    expect(line?.status).toBe(500);
    expect(line?.level).toBe(50); // error
  });

  it('logs 4xx at warn level', async () => {
    await request(app).get('/nope').set('X-Request-Id', 'trace-404-1').expect(404);

    const line = lines('http.response').find((l) => l.requestId === 'trace-404-1');
    expect(line?.status).toBe(404);
    expect(line?.level).toBe(40); // warn
  });

  it('records the query string but not the raw path with it', async () => {
    await request(app).get('/ping?page=2&perPage=10').set('X-Request-Id', 'trace-query-1');

    const line = lines('http.response').find((l) => l.requestId === 'trace-query-1');
    expect(line?.path).toBe('/ping');
    expect(line?.query).toEqual({ page: '2', perPage: '10' });
  });

  it('skips ignored paths like /health', async () => {
    await request(app).get('/health').set('X-Request-Id', 'trace-health-1').expect(200);

    expect(lines('http.response').some((l) => l.requestId === 'trace-health-1')).toBe(false);
  });

  it('does not log a body unless LOG_HTTP_BODY is on', async () => {
    await request(app)
      .post('/echo')
      .set('X-Request-Id', 'trace-nobody-1')
      .send({ hello: 'world' })
      .expect(200);

    const line = lines('http.response').find((l) => l.requestId === 'trace-nobody-1');
    expect(line).toBeDefined();
    expect(line?.body).toBeUndefined();
  });

  describe('with LOG_HTTP_BODY on', () => {
    beforeAll(() => {
      env.log.httpBody = true;
    });
    afterAll(() => {
      env.log.httpBody = false;
    });

    it('logs the body with secrets redacted at ANY depth', async () => {
      await request(app)
        .post('/echo')
        .set('X-Request-Id', 'trace-body-1')
        .send({
          username: 'someone@example.com',
          password: 'top-level-secret',
          // pino's one-level `*.key` redact paths do NOT reach these — scrubDeep does.
          profile: { nested: { refreshToken: 'deep-secret' } },
          devices: [{ idToken: 'array-secret' }],
        })
        .expect(200);

      const line = lines('http.response').find((l) => l.requestId === 'trace-body-1');
      const body = line?.body as Record<string, any>;
      expect(body.username).toBe('someone@example.com');
      expect(body.password).toBe('[redacted]');
      expect(body.profile.nested.refreshToken).toBe('[redacted]');
      expect(body.devices[0].idToken).toBe('[redacted]');
    });

    it('scrubs BEFORE truncating, so an over-cap body cannot leak a secret', async () => {
      // Regression guard: truncation yields a JSON *string*, which pino's redact
      // cannot walk. If the order ever flips, the secret below shows up verbatim.
      await request(app)
        .post('/echo')
        .set('X-Request-Id', 'trace-body-big')
        .send({ password: 'leaky-secret-value', filler: 'x'.repeat(4000) })
        .expect(200);

      const line = lines('http.response').find((l) => l.requestId === 'trace-body-big');
      expect(typeof line?.body).toBe('string');
      const body = line?.body as string;
      expect(body).toContain('[redacted]');
      expect(body).not.toContain('leaky-secret-value');
      expect(body).toContain('[truncated');
    });

    it('logs what the CLIENT sent, not the whitelisted DTO', async () => {
      // The whole point: a field the DTO drops (typo'd / renamed by the FE) is the
      // most common client bug, and reading req.body would hide it completely.
      await request(app)
        .post('/dto')
        .set('X-Request-Id', 'trace-body-raw')
        .send({ known: 'kept', typodField: 'dropped-by-dto', password: 'secret' })
        .expect(200);

      const line = lines('http.response').find((l) => l.requestId === 'trace-body-raw');
      const body = line?.body as Record<string, unknown>;
      expect(body.known).toBe('kept');
      expect(body.typodField).toBe('dropped-by-dto');
      expect(body.password).toBe('[redacted]');
    });

    it('never echoes a malformed body verbatim (it cannot be scrubbed)', async () => {
      await request(app)
        .post('/echo')
        .set('X-Request-Id', 'trace-body-bad')
        .set('content-type', 'application/json')
        .send('{"password":"secret",,,}')
        .expect(400);

      const line = lines('http.response').find((l) => l.requestId === 'trace-body-bad');
      expect(line?.body).toMatch(/^\[unparseable json body \d+b\]$/);
      expect(JSON.stringify(line)).not.toContain('secret');
    });

    it('omits the body key entirely for GET requests', async () => {
      await request(app).get('/ping').set('X-Request-Id', 'trace-body-get').expect(200);

      const line = lines('http.response').find((l) => l.requestId === 'trace-body-get');
      expect(line?.body).toBeUndefined();
    });
  });

  it('logs the query the CLIENT sent, not the DTO that replaced it', async () => {
    await request(app)
      .get('/dto-query?page=2&typoParam=dropped')
      .set('X-Request-Id', 'trace-query-raw')
      .expect(200);

    const line = lines('http.response').find((l) => l.requestId === 'trace-query-raw');
    // Snapshotted on arrival: strings stay strings, and the param the DTO would
    // have whitelisted away is still visible — that is the bug worth seeing.
    expect(line?.query).toEqual({ page: '2', typoParam: 'dropped' });
  });

  it('omits the query key entirely when there is no query string', async () => {
    await request(app).get('/ping').set('X-Request-Id', 'trace-query-none').expect(200);

    const line = lines('http.response').find((l) => l.requestId === 'trace-query-none');
    expect(line).toBeDefined();
    expect('query' in (line as object)).toBe(false);
  });

  it('redacts secrets in query strings too', async () => {
    await request(app).get('/ping?otp=123456&page=2').set('X-Request-Id', 'trace-query-secret');

    const line = lines('http.response').find((l) => l.requestId === 'trace-query-secret');
    expect(line?.query).toEqual({ otp: '[redacted]', page: '2' });
  });

  describe('with LOG_HTTP_INCOMING on', () => {
    beforeAll(() => {
      env.log.httpIncoming = true;
    });
    afterAll(() => {
      env.log.httpIncoming = false;
    });

    it('carries the query on the arrival line, where it belongs semantically', async () => {
      await request(app).get('/ping?page=3&otp=999').set('X-Request-Id', 'trace-in-1').expect(200);

      const line = lines('http.request').find((l) => l.requestId === 'trace-in-1');
      expect(line?.query).toEqual({ page: '3', otp: '[redacted]' });
      // Body is deliberately absent: express.json has not read the socket yet.
      expect(line?.body).toBeUndefined();
    });
  });

  it('redacts secrets anywhere in a logged object', async () => {
    // Guards the pino redact config, which is what keeps LOG_HTTP_BODY and any
    // future `logger.info({ body })` from printing credentials.
    logger.info({ password: 'hunter2', body: { refreshToken: 'rt-secret' } }, 'redaction.probe');

    const line = lines('redaction.probe')[0];
    expect(line?.password).toBe('[redacted]');
    expect((line?.body as Record<string, string>).refreshToken).toBe('[redacted]');
  });
});
