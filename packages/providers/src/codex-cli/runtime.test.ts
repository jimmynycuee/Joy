import { describe, expect, it } from 'vitest'
import { fakeWsl } from '../../test-support/fixtures.js'
import { probeWslCodex, toWslPath } from './runtime.js'

const env: NodeJS.ProcessEnv = { ...process.env }
const wslPrefix = [fakeWsl]

describe('Codex Windows runtime routing', () => {
  it('detects the WSL Codex runtime without relying on login state', async () => {
    await expect(probeWslCodex(process.execPath, wslPrefix, 'codex', env)).resolves.toMatchObject({
      installed: true,
      ok: true,
      version: 'codex fake-wsl 1.0.0',
    })
  })

  it('converts Windows paths for WSL using wslpath arguments', async () => {
    await expect(
      toWslPath(process.execPath, wslPrefix, 'C:\\Users\\Joy\\repo with spaces', env),
    ).resolves.toBe('/mnt/c/Users/Joy/repo with spaces')
  })
})
