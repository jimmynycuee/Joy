import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'assistant', include: ['src/**/*.test.ts'] },
})
