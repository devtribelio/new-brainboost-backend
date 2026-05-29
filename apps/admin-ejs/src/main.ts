import 'reflect-metadata';
import { buildApp } from './app';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';

async function bootstrap() {
  const app = buildApp();
  const port = Number(process.env.ADMIN_PORT) || 3002;

  const server = app.listen(port, () => {
    logger.info(`[admin-ejs] listening on :${port} (${env.nodeEnv})`);
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
