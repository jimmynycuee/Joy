import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/

export function readApiToken(command: 'build' | 'serve', isPreview = false): string {
  if (command === 'build' || isPreview) return ''

  const environmentToken = process.env.JOY_API_TOKEN?.trim()
  if (environmentToken) {
    assertApiToken(environmentToken)
    return environmentToken
  }

  const joyHome = process.env.JOY_HOME ?? join(homedir(), '.joy')
  const tokenFile = process.env.JOY_API_TOKEN_FILE?.trim() || join(joyHome, 'api-token')
  let fileToken = ''
  let metadata: ReturnType<typeof lstatSync> | undefined
  try {
    metadata = lstatSync(tokenFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Could not inspect the Joy API token file at ${tokenFile}. Set JOY_API_TOKEN or provide a readable JOY_API_TOKEN_FILE.`,
        { cause: error },
      )
    }
  }
  if (metadata) {
    if (metadata.isSymbolicLink())
      throw new Error(`Joy API token file must not be a symbolic link: ${tokenFile}`)
    if (!metadata.isFile()) throw new Error(`Joy API token path must be a regular file: ${tokenFile}`)
    if (process.platform !== 'win32' && (Number(metadata.mode) & 0o077) !== 0) {
      throw new Error(`Joy API token file permissions must restrict access to its owner: ${tokenFile}`)
    }
    try {
      fileToken = readFileSync(tokenFile, 'utf8').trim()
    } catch (error) {
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
  assertApiToken(fileToken)
  return fileToken
}

function assertApiToken(token: string): void {
  if (!API_TOKEN_PATTERN.test(token)) {
    throw new Error('Joy API token must contain at least 16 URL-safe characters.')
  }
}

export default defineConfig(({ command, isPreview }) => ({
  define: { __JOY_API_TOKEN__: JSON.stringify(readApiToken(command, isPreview)) },
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
