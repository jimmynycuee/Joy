import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'orchestrator', include: ['src/**/*.test.ts'] },
})
