import { defineConfig } from 'tsup';

export default defineConfig({
  // main.ts = HTTP API; workers/* = standalone outbox→SQS daemons, one per queue
  // family (run as their own pm2 processes — see ecosystem.config.js).
  entry: [
    'src/main.ts',
    'src/jobs-runner.ts',
    'src/workers/comms-relay.ts',
    'src/workers/push-relay.ts',
  ],
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  tsconfig: 'tsconfig.build.json',
  // Bundle workspace packages; keep node_modules deps external. pino + its
  // worker-thread transports (thread-stream/pino-pretty) MUST stay external —
  // bundling them breaks the worker file path resolution at runtime.
  noExternal: [/^@bb\//],
  external: ['pino', 'pino-pretty', 'thread-stream', 'sharp'],
});
