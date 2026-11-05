import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function readApiToken(command: 'build' | 'serve'): string {
  if (command === 'build') return ''

  const environmentToken = process.env.JOY_API_TOKEN?.trim()
  if (environmentToken) return environmentToken

  const tokenFile = process.env.JOY_API_TOKEN_FILE?.trim() || join(homedir(), '.joy', 'api-token')
  let fileToken = ''
  try {
    fileToken = readFileSync(tokenFile, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Could not read the Joy API token file at ${tokenFile}. Set JOY_API_TOKEN or provide a readable JOY_API_TOKEN_FILE.`,
        { cause: error },
      )
    }
  }
  if (!fileToken) {
    throw new Error(
      `Joy API token is required to run the web UI. Set JOY_API_TOKEN or create ${tokenFile} (or set JOY_API_TOKEN_FILE).`,
    )
  }
  return fileToken
}

export default defineConfig(({ command }) => ({
  define: { __JOY_API_TOKEN__: JSON.stringify(readApiToken(command)) },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // Preserve the browser's same-origin headers so the API can enforce them.
    cors: false,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4317',
        changeOrigin: false,
        ws: true,
      },
    },
  },
}))
