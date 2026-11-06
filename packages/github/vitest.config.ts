import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'github',
    include: ['src/**/*.test.ts'],
    // Removing large temp repos is slow on Windows runners.
    hookTimeout: 60_000,
    // Publisher tests create real Git repositories and are substantially slower on Windows CI.
    testTimeout: 30_000,
  },
})
