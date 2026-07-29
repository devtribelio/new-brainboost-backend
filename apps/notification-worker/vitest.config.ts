import { defineConfig } from 'vitest/config';
import path from 'node:path';

const pkg = (p: string) => path.resolve(__dirname, '../../packages', p);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, '../../tests/setup.ts')],
    include: ['tests/**/*.spec.ts'],
    testTimeout: 15000,
  },
  resolve: {
    // Resolve @bb/* to package SOURCE (not built dist) so the whole graph is
    // compiled by one esbuild pass — same reasoning as apps/mobile-api.
    alias: [
      { find: /^@bb\/common$/, replacement: pkg('common/src/index.ts') },
      { find: /^@bb\/common\/(.*)$/, replacement: pkg('common/src/$1') },
      { find: /^@bb\/domain$/, replacement: pkg('domain/src/index.ts') },
      { find: /^@bb\/domain\/(.*)$/, replacement: pkg('domain/src/$1') },
      { find: /^@bb\/db$/, replacement: pkg('db/src/index.ts') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
});
