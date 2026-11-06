import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'policy', include: ['src/**/*.test.ts'] },
})
