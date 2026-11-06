import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'channels', include: ['src/**/*.test.ts'] },
})
