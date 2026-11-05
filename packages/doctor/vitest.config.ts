import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'doctor',
    include: ['src/**/*.test.ts'],
  },
})
