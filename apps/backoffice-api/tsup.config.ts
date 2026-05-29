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
  // Bundle workspace packages; keep node_modules deps external.
  noExternal: [/^@bb\//],
});
