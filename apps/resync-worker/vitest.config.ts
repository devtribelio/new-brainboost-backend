import { defineConfig } from 'vitest/config';
import path from 'node:path';

const pkg = (p: string) => path.resolve(__dirname, '../../packages', p);

export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: [
      { find: /^@bb\/common$/, replacement: pkg('common/src/index.ts') },
      { find: /^@bb\/common\/(.*)$/, replacement: pkg('common/src/$1') },
    ],
  },
});
