import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'scheduler', include: ['src/**/*.test.ts'] },
})
