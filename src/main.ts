import 'reflect-metadata';
import { buildApp } from './app';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';

async function bootstrap() {
  const app = buildApp();

  const server = app.listen(env.port, () => {
    logger.info(`[${env.appName}] listening on :${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to bootstrap');
  process.exit(1);
});
