import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    maxWorkers: 4,
    coverage: {
      reporter: ['text', 'json-summary'],
    },
  },
})
