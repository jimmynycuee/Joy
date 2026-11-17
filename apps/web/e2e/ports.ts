/**
 * Ports the E2E run listens on. The defaults are the ones `pnpm web` and the background service use, so on a machine
 * already running Joy set `JOY_E2E_WEB_PORT` and `JOY_E2E_API_PORT` to free ports instead of editing files.
 */
export const E2E_WEB_PORT = portFromEnv('JOY_E2E_WEB_PORT', 5173)
export const E2E_API_PORT = portFromEnv('JOY_E2E_API_PORT', 4317)
export const E2E_WEB_ORIGIN = `http://127.0.0.1:${E2E_WEB_PORT}`

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a TCP port (1-65535), got '${raw}'`)
  return port
}
