import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'model-effort', include: ['src/**/*.test.ts'] },
})
