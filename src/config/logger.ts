import pino from 'pino';
import { env } from './env';

export const logger = pino({
  name: env.appName,
  level: env.log.level,
  transport: env.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
      },
});
