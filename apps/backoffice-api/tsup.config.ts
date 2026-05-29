import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
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
  external: ['pino', 'pino-pretty', 'thread-stream'],
});
