import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    // Each test closes a full server (running tasks, backups, timers) in afterEach. That takes milliseconds locally,
    // but the shared macOS and Windows CI runners occasionally stall past Vitest's 10 s default (seen twice).
    hookTimeout: 60_000,
  },
})
