import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_TOKEN_FILENAME = 'api-token'
const WS_API_PROTOCOL = 'joy-api-v1'
const WS_TOKEN_PROTOCOL_PREFIX = 'joy-auth.'

function readApiToken(): string {
  const path = join(process.env.JOY_HOME ?? join(homedir(), '.joy'), API_TOKEN_FILENAME)
  let info
  try {
    info = lstatSync(path)
  } catch {
    throw new Error('Joy API token is unavailable; start the Joy server before the web UI.')
  }
  if (!info.isFile()) throw new Error('Joy API token file is invalid or not private.')
  if (process.platform === 'win32') {
    verifyWindowsApiTokenAcl(path)
  } else if (
    typeof process.getuid !== 'function' ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error('Joy API token file is invalid or not private.')
  }
  let token: string
  try {
    token = readFileSync(path, 'utf8')
  } catch {
    throw new Error('Joy API token file is invalid or not private.')
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Joy API token file is invalid or not private.')
  return token
}

function verifyWindowsApiTokenAcl(path: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:JOY_API_TOKEN_FILE
$acl = Get-Acl -LiteralPath $path
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$ownerSid = $acl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value
$allowRules = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
$unexpected = @($allowRules | Where-Object {
  $_.IsInherited -or $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value
})
if ($ownerSid -ne $currentSid.Value -or $allowRules.Count -ne 1 -or $unexpected.Count -ne 0) {
  throw 'Unexpected API token ACL.'
}
`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, JOY_API_TOKEN_FILE: path },
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    })
  } catch {
    throw new Error('Joy API token file is invalid or not private.')
  }
}

export default defineConfig(({ command }) => {
  const apiToken = command === 'serve' ? readApiToken() : ''
  return {
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
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest) => {
              proxyRequest.setHeader('authorization', `Bearer ${apiToken}`)
            })
          },
        },
        '/ws': {
          target: 'ws://127.0.0.1:4317',
          changeOrigin: false,
          ws: true,
          configure(proxy) {
            proxy.on('proxyReqWs', (proxyRequest) => {
              proxyRequest.setHeader(
                'sec-websocket-protocol',
                `${WS_API_PROTOCOL}, ${WS_TOKEN_PROTOCOL_PREFIX}${apiToken}`,
              )
            })
          },
        },
      },
    },
  }
})
