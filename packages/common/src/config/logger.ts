import pino from 'pino';
import { env } from './env';
import { getRequestContext } from './request-context';
import { CENSOR, redactPaths } from './log-redaction';

export const logger = pino({
  name: env.appName,
  level: env.log.level,
  // Cheap insurance: a future `logger.info({ body })` somewhere in a service
  // cannot print a password or a bearer token. Key list: config/log-redaction.ts.
  redact: { paths: redactPaths, censor: CENSOR },
  // Every log line — including the ~60 existing `logger.*` calls in
  // @bb/domain — automatically carries the ambient request context, so a
  // service log can be traced back to the HTTP request that caused it. Outside
  // a request (workers, cron, tests) there is no context and nothing is added.
  // See config/request-context.ts.
  mixin() {
    const ctx = getRequestContext();
    if (!ctx) return {};
    return {
      requestId: ctx.requestId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(ctx.route ? { route: ctx.route } : { path: ctx.path }),
    };
  },
  transport: env.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
      },
});
