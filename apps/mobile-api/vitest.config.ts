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
    // Single instance of the decorator libs across app src + @bb/* sources,
    // else @Type/@IsInt metadata lands in a different storage than the one
    // plainToInstance/validate read → query coercion silently fails.
    dedupe: ['class-transformer', 'class-validator', 'reflect-metadata'],
    // Resolve @bb/* to package SOURCE (not built dist) so the whole graph is
    // compiled by one esbuild pass. Loading @bb/common from dist (CJS) while
    // app DTOs load from src yields two class-transformer instances → split
    // decorator-metadata storage → query DTO @Type coercion silently lost.
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
