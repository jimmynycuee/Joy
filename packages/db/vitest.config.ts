import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts'],
    // These tests drive real git and SQLite on disk. Shared Windows CI runners sometimes take longer than Vitest's
    // 5 s / 10 s defaults for that I/O (seen on PRs #141 and #142), so allow more time instead of skipping them.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
