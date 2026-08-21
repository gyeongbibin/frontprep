import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  dts: false,
  minify: false,
  sourcemap: true,
  splitting: false,
  target: 'node20',
  banner: {
    js: '#!/usr/bin/env node',
  },
})
