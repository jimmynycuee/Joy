import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findServiceNode,
  isSupportedNodeVersion,
  isTemporaryNodePath,
  planService,
  realServiceDeps,
  runService,
  servicePath,
  ServiceError,
} from './service.js'
import type {
  NodeSearchDeps,
  PlanInput,
  RunResult,
  ServiceDeps,
  ServiceFile,
  ServiceOptions,
} from './service.js'
import { uiBuildState } from './ui-build.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'joy-service-test-'))
  dirs.push(dir)
  return dir
}

const posixInput: PlanInput = {
  platform: 'darwin',
  nodePath: '/opt/homebrew/opt/node@22/bin/node',
  repoRoot: '/Users/me/Joy',
  joyHome: '/Users/me/.joy',
  userHome: '/Users/me',
  port: 4317,
  uid: 501,
  env: { PATH: '/Users/me/.local/bin:/usr/bin' },
}

describe('planService on macOS', () => {
  const plan = planService(posixInput)
  const file = plan.files[0] as ServiceFile

  it('writes one LaunchAgent that runs the absolute Node with tsx from the checkout', () => {
    expect(file.path).toBe('/Users/me/Library/LaunchAgents/com.joy.local.plist')
    expect(file.content).toContain('<key>Label</key>\n  <string>com.joy.local</string>')
    const args = [...file.content.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1])
    expect(args).toEqual(
      expect.arrayContaining([
        '/opt/homebrew/opt/node@22/bin/node',
        '--import',
        'tsx',
        '/Users/me/Joy/scripts/joy.ts',
        'start',
        '--port',
        '4317',
      ]),
    )
    expect(file.content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(file.content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(file.content).toContain('<key>WorkingDirectory</key>\n  <string>/Users/me/Joy</string>')
    expect(file.content).toContain('/Users/me/.joy/logs/service.out.log')
    expect(file.content).toContain('/Users/me/.joy/logs/service.err.log')
  })

  it('loads and unloads it in the owner user domain without a shell', () => {
    expect(plan.install).toEqual([
      { command: 'launchctl', args: ['bootout', 'gui/501/com.joy.local'], ignoreFailure: true },
      {
        command: 'launchctl',
        args: ['bootstrap', 'gui/501', '/Users/me/Library/LaunchAgents/com.joy.local.plist'],
        retries: 3,
      },
    ])
    expect(plan.uninstall).toEqual([
      { command: 'launchctl', args: ['bootout', 'gui/501/com.joy.local'], ignoreFailure: true },
    ])
    expect(plan.status).toEqual({ command: 'launchctl', args: ['print', 'gui/501/com.joy.local'] })
  })

  it('passes only PATH, with the Node folder first and no npx or node_modules folders', () => {
    expect(file.content.match(/<key>(?!Label|ProgramArguments)[A-Za-z]+<\/key>/g)).toBeTruthy()
    const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(file.content)?.[1]
    expect([...(environment ?? '').matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])).toEqual([
      'PATH',
    ])
    const dirty = servicePath({
      ...posixInput,
      env: {
        PATH: [
          '/Users/me/Joy/node_modules/.bin',
          '/Users/me/.npm/_npx/abc/node_modules/.bin',
          '/Users/me/.npm/_npx/abc/bin',
          'relative/bin',
          '/Users/me/.local/bin',
          '/Users/me/.local/bin',
        ].join(':'),
      },
    })
    expect(dirty.split(':')).toEqual([
      '/opt/homebrew/opt/node@22/bin',
      '/Users/me/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ])
  })

  it('keeps JOY_HOME only when the installing terminal had one, and escapes XML', () => {
    const custom = planService({
      ...posixInput,
      repoRoot: '/Users/me/R&D <Joy>',
      env: { PATH: '/usr/bin', JOY_HOME: '/Volumes/data/joy' },
    }).files[0] as ServiceFile
    expect(custom.content).toContain('<key>JOY_HOME</key>\n    <string>/Volumes/data/joy</string>')
    expect(custom.content).toContain('/Users/me/R&amp;D &lt;Joy&gt;/scripts/joy.ts')
    expect(custom.content).not.toContain('R&D')
  })

  it('writes no secret: nothing but PATH and an optional JOY_HOME is copied from the environment', () => {
    const secret = 'sk-test-secret-should-never-appear'
    const withSecrets = planService({
      ...posixInput,
      env: { PATH: '/usr/bin', OPENAI_API_KEY: secret } as NonNullable<PlanInput['env']>,
    })
    expect(JSON.stringify(withSecrets)).not.toContain(secret)
  })
})

describe('planService on Linux', () => {
  const plan = planService({
    ...posixInput,
    platform: 'linux',
    userHome: '/home/me',
    joyHome: '/home/me/.joy',
  })
  const file = plan.files[0] as ServiceFile

  it('writes a systemd user unit and enables it', () => {
    expect(file.path).toBe('/home/me/.config/systemd/user/joy-local.service')
    expect(file.content).toContain('WorkingDirectory=/Users/me/Joy')
    expect(file.content).toContain(
      'ExecStart="/opt/homebrew/opt/node@22/bin/node" "--import" "tsx" "/Users/me/Joy/scripts/joy.ts" "start" "--port" "4317"',
    )
    expect(file.content).toContain('Restart=on-failure')
    expect(file.content).toContain('WantedBy=default.target')
    expect(file.content).toContain('StandardOutput=append:/home/me/.joy/logs/service.out.log')
    expect(plan.install.map((step) => [step.command, ...step.args].join(' '))).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable joy-local.service',
      'systemctl --user restart joy-local.service',
    ])
    expect(plan.uninstall).toEqual([
      {
        command: 'systemctl',
        args: ['--user', 'disable', '--now', 'joy-local.service'],
        ignoreFailure: true,
      },
    ])
  })

  it('quotes paths with spaces, quotes, percent signs and dollars, and honours XDG_CONFIG_HOME', () => {
    const odd = planService({
      ...posixInput,
      platform: 'linux',
      nodePath: '/opt/My Node/50%/bin/node',
      repoRoot: '/srv/joy "x"/$HOME',
      env: { PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/me/cfg' },
    }).files[0] as ServiceFile
    expect(odd.path).toBe('/home/me/cfg/systemd/user/joy-local.service')
    expect(odd.content).toContain('"/opt/My Node/50%%/bin/node"')
    expect(odd.content).toContain('"/srv/joy \\"x\\"/$$HOME/scripts/joy.ts"')
    expect(odd.content).toContain('WorkingDirectory=/srv/joy "x"/$HOME')
  })
})

describe('planService on Windows', () => {
  const input: PlanInput = {
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    repoRoot: 'C:\\Users\\me\\Joy',
    joyHome: 'C:\\Users\\me\\.joy',
    userHome: 'C:\\Users\\me',
    port: 4317,
    env: { USERDOMAIN: 'PC', USERNAME: 'me', PATH: 'C:\\Windows\\System32' },
  }
  const plan = planService(input)
  const file = plan.files[0] as ServiceFile

  it('registers a logon task from a UTF-16 XML file, without the 72 hour limit', () => {
    expect(file.path).toBe('C:\\Users\\me\\.joy\\service\\joy-local-task.xml')
    expect(file.encoding).toBe('utf16le')
    expect(file.content).toContain('<LogonTrigger>')
    expect(file.content).toContain('<UserId>PC\\me</UserId>')
    expect(file.content).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(file.content).toContain('<Command>conhost.exe</Command>')
    expect(file.content).toContain(
      '<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; --import tsx C:\\Users\\me\\Joy\\scripts\\joy.ts start --port 4317</Arguments>',
    )
    expect(file.content).toContain('<WorkingDirectory>C:\\Users\\me\\Joy</WorkingDirectory>')
    expect(plan.install).toEqual([
      { command: 'schtasks', args: ['/End', '/TN', 'joy-local'], ignoreFailure: true },
      { command: 'schtasks', args: ['/Create', '/TN', 'joy-local', '/XML', file.path, '/F'] },
      { command: 'schtasks', args: ['/Run', '/TN', 'joy-local'] },
    ])
    expect(plan.uninstall.map((step) => step.args.slice(0, 3))).toEqual([
      ['/End', '/TN', 'joy-local'],
      ['/Delete', '/TN', 'joy-local'],
    ])
    expect(plan.status.args).toEqual(['/Query', '/TN', 'joy-local', '/FO', 'LIST', '/V'])
  })

  it('quotes an argument that has spaces', () => {
    const spaced = planService({ ...input, repoRoot: 'C:\\My Files\\Joy' }).files[0] as ServiceFile
    expect(spaced.content).toContain('&quot;C:\\My Files\\Joy\\scripts\\joy.ts&quot;')
  })
})

describe('service manager details', () => {
  it('slows restarts down: launchd ThrottleInterval and systemd RestartSec are both 30 seconds', () => {
    const mac = planService(posixInput).files[0] as ServiceFile
    expect(mac.content).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/)
    const linux = planService({ ...posixInput, platform: 'linux' }).files[0] as ServiceFile
    expect(linux.content).toContain('RestartSec=30')
  })

  it('does not escape $ in systemd Environment= (only ExecStart expands it), and refuses newlines in paths', () => {
    const unit = planService({
      ...posixInput,
      platform: 'linux',
      repoRoot: '/srv/$joy',
      env: { PATH: '/opt/$bin:/usr/bin' },
    }).files[0] as ServiceFile
    expect(unit.content).toContain(':/opt/$bin:/usr/bin')
    expect(unit.content).not.toContain('$$bin')
    expect(unit.content).toContain('"/srv/$$joy/scripts/joy.ts"')
    expect(() =>
      planService({ ...posixInput, platform: 'linux', repoRoot: '/srv/a\nExecStart=/bin/evil' }),
    ).toThrow('換行')
    expect(() => planService({ ...posixInput, platform: 'linux', joyHome: '/h/a\rb' })).toThrow('換行')
  })

  it('uses names that will not replace an unrelated joy of the owner', () => {
    expect((planService({ ...posixInput, platform: 'linux' }).files[0] as ServiceFile).path).toMatch(
      /joy-local\.service$/,
    )
    const win = planService({
      ...posixInput,
      platform: 'win32',
      nodePath: 'C:\\n\\node.exe',
      repoRoot: 'C:\\Joy',
      joyHome: 'C:\\h\\.joy',
      userHome: 'C:\\h',
    })
    expect(JSON.stringify(win.install)).toContain('"joy-local"')
    expect(JSON.stringify(win.install)).not.toContain('"joy"')
  })

  it('tells a Windows owner what the task cannot carry: PATH, JOY_HOME, and that the hidden window is unverified', () => {
    const win = planService({
      ...posixInput,
      platform: 'win32',
      nodePath: 'C:\\n\\node.exe',
      repoRoot: 'C:\\Joy',
      joyHome: 'C:\\h\\.joy',
      userHome: 'C:\\h',
      env: { JOY_HOME: 'D:\\joy-data' },
    })
    const notes = win.notes.join('\n')
    expect(notes).toContain('PATH')
    expect(notes).toContain('D:\\joy-data')
    expect(notes).toContain('尚待實機驗證')
    expect(
      planService({
        ...posixInput,
        platform: 'win32',
        nodePath: 'C:\\n\\node.exe',
        repoRoot: 'C:\\Joy',
        joyHome: 'C:\\h\\.joy',
        userHome: 'C:\\h',
      }).notes.join('\n'),
    ).not.toContain('JOY_HOME')
  })
})

describe('planService errors', () => {
  it('refuses an unsupported system and a bad port', () => {
    expect(() => planService({ ...posixInput, platform: 'freebsd' })).toThrow(ServiceError)
    expect(() => planService({ ...posixInput, port: 70000 })).toThrow('--port')
    expect(() => planService({ ...posixInput, uid: undefined })).toThrow('uid')
  })
})

describe('finding a Node 22 for the service', () => {
  it('accepts only 22.13 and later 22.x', () => {
    expect(['v22.13.0', 'v22.23.5', '22.14.1'].every(isSupportedNodeVersion)).toBe(true)
    expect(
      ['v22.12.9', 'v20.19.0', 'v23.0.0', 'v24.1.0', 'v25.9.0', 'nonsense'].some(isSupportedNodeVersion),
    ).toBe(false)
  })

  it('treats every pnpm dlx cache layout as temporary', () => {
    expect(isTemporaryNodePath('/Users/me/Library/Caches/pnpm/dlx/abc123/node_modules/node/bin/node')).toBe(
      true,
    )
    expect(isTemporaryNodePath('C:\\Users\\me\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node.exe')).toBe(true)
    expect(isTemporaryNodePath('/opt/dlxtools/bin/node')).toBe(false)
  })

  it('treats npx and pnpm dlx caches and the temp folder as temporary', () => {
    expect(isTemporaryNodePath('/Users/me/.npm/_npx/1558/node_modules/node/bin/node')).toBe(true)
    expect(isTemporaryNodePath('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node.exe')).toBe(true)
    expect(isTemporaryNodePath('/Users/me/.cache/pnpm/dlx-123/abc/node')).toBe(true)
    expect(isTemporaryNodePath('/var/folders/x/T/foo/node', '/var/folders/x/T')).toBe(true)
    expect(isTemporaryNodePath('/opt/homebrew/opt/node@22/bin/node', '/var/folders/x/T')).toBe(false)
  })

  /** A file system of fake Node installs: path → `node --version`. */
  function fakeNodes(
    installed: Record<string, string>,
    folders: Record<string, string[]> = {},
  ): NodeSearchDeps {
    return {
      exists: (target) => target in installed,
      list: (dir) => folders[dir] ?? [],
      version: async (target) => installed[target],
    }
  }
  const base = {
    platform: 'darwin' as const,
    userHome: '/Users/me',
    execPath: '/Users/me/.npm/_npx/1558/node_modules/node/bin/node',
    execVersion: 'v22.23.5',
  }

  it('uses the running Node when it is a lasting Node 22', async () => {
    const found = await findServiceNode(
      { ...base, execPath: '/usr/local/bin/node', execVersion: 'v22.14.0' },
      fakeNodes({}),
    )
    expect(found).toMatchObject({ path: '/usr/local/bin/node', source: '目前執行的 Node' })
  })

  it('skips an npx Node and a wrong major, and finds Homebrew node@22', async () => {
    const deps = fakeNodes({
      '/opt/homebrew/bin/node': 'v25.9.0',
      '/opt/homebrew/opt/node@22/bin/node': 'v22.14.0',
    })
    expect(await findServiceNode(base, deps)).toEqual({
      path: '/opt/homebrew/opt/node@22/bin/node',
      version: 'v22.14.0',
      source: 'Homebrew node@22',
    })
  })

  it('picks the newest 22 from nvm and fnm, ignoring other majors and too-old 22s', async () => {
    const nvm = '/Users/me/.nvm/versions/node'
    const found = await findServiceNode(
      base,
      fakeNodes(
        {
          [`${nvm}/v22.14.0/bin/node`]: 'v22.14.0',
          [`${nvm}/v22.20.1/bin/node`]: 'v22.20.1',
        },
        { [nvm]: ['v20.1.0', 'v22.12.0', 'v22.14.0', 'v22.20.1', 'v25.0.0'] },
      ),
    )
    expect(found).toMatchObject({ path: `${nvm}/v22.20.1/bin/node`, source: 'nvm' })
    const fnm = '/Users/me/Library/Application Support/fnm/node-versions'
    const viaFnm = await findServiceNode(
      base,
      fakeNodes({ [`${fnm}/v22.15.0/installation/bin/node`]: 'v22.15.0' }, { [fnm]: ['v22.15.0'] }),
    )
    expect(viaFnm).toMatchObject({ source: 'fnm' })
  })

  it('explains what to do when there is no Node 22', async () => {
    const error = await findServiceNode(base, fakeNodes({ '/opt/homebrew/bin/node': 'v25.9.0' })).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(ServiceError)
    expect((error as Error).message).toContain('brew install node@22')
    expect((error as Error).message).toContain('--node')
    expect((error as Error).message).toContain('npx')
  })

  it('checks an explicit --node: absolute, lasting, runnable and Node 22', async () => {
    const deps = fakeNodes({ '/opt/n22/bin/node': 'v22.14.0', '/opt/n25/bin/node': 'v25.9.0' })
    expect(await findServiceNode({ ...base, explicit: '/opt/n22/bin/node' }, deps)).toMatchObject({
      path: '/opt/n22/bin/node',
      source: '--node 參數',
    })
    const failure = (explicit: string) =>
      findServiceNode({ ...base, explicit }, deps).then(
        () => '',
        (cause: Error) => cause.message,
      )
    expect(await failure('node')).toContain('絕對路徑')
    expect(await failure('/Users/me/.npm/_npx/1/node')).toContain('暫存')
    expect(await failure('/opt/missing/node')).toContain('不存在')
    expect(await failure('/opt/n25/bin/node')).toContain('v25.9.0')
  })
})

/** Fake deps: an in-memory file system, a scripted program runner and a record of everything that happened. */
function fakeDeps(
  options: {
    files?: Record<string, string>
    nodes?: Record<string, string>
    results?: (command: string, args: string[], call: number) => Partial<RunResult>
    healthy?: boolean
    ui?: 'missing' | 'stale' | 'fresh'
  } = {},
) {
  const files = new Map(Object.entries(options.files ?? {}))
  const calls: string[] = []
  const written: ServiceFile[] = []
  const folders: Array<[string, number | undefined]> = []
  const lines: string[] = []
  let sleeps = 0
  const deps: ServiceDeps = {
    exists: (target) => files.has(target) || target in (options.nodes ?? {}),
    list: () => [],
    version: async (target) => options.nodes?.[target],
    run: async (command, args) => {
      calls.push([command, ...args].join(' '))
      return { status: 0, stdout: '', stderr: '', ...options.results?.(command, args, calls.length) }
    },
    mkdir: async (target, mode) => void folders.push([target, mode]),
    write: async (file) => {
      written.push(file)
      files.set(file.path, file.content)
    },
    remove: async (target) => void files.delete(target),
    sleep: async () => void sleeps++,
    health: async () => options.healthy ?? false,
    uiState: () => options.ui ?? 'fresh',
    out: (line) => lines.push(line),
  }
  return { deps, files, calls, written, folders, lines, sleeps: () => sleeps }
}

const serviceOptions: ServiceOptions = {
  platform: 'darwin',
  userHome: '/Users/me',
  joyHome: '/Users/me/.joy',
  repoRoot: '/Users/me/Joy',
  port: 4317,
  dryRun: false,
  node: '/opt/n22/bin/node',
  uid: 501,
  execPath: '/Users/me/.npm/_npx/1/node',
  execVersion: 'v22.23.5',
  env: { PATH: '/usr/bin' },
}
const installedNode = {
  '/opt/n22/bin/node': 'v22.14.0',
  '/Users/me/Joy/node_modules/tsx': 'dir',
}

describe('service install, uninstall and status', () => {
  it('--dry-run prints the files and commands and changes nothing', async () => {
    const env = fakeDeps({ nodes: installedNode, ui: 'missing' })
    expect(await runService('install', { ...serviceOptions, dryRun: true }, env.deps)).toBe(0)
    const output = env.lines.join('\n')
    expect(output).toContain('/Users/me/Library/LaunchAgents/com.joy.local.plist')
    expect(output).toContain('launchctl bootstrap gui/501')
    expect(output).toContain('--dry-run：沒有寫入設定檔，也沒有安裝、啟動或重新啟動服務。')
    expect(output).toContain('pnpm joy build-ui')
    expect(output).toContain('http://127.0.0.1:4317 會是空的')
    expect(output).not.toContain('${')
    expect(env.written).toEqual([])
    expect(env.calls).toEqual([])
    expect(env.folders).toEqual([])
  })

  it('writes the file, then runs the commands in order', async () => {
    const env = fakeDeps({ nodes: installedNode })
    expect(await runService('install', serviceOptions, env.deps)).toBe(0)
    expect(env.written.map((file) => file.path)).toEqual([
      '/Users/me/Library/LaunchAgents/com.joy.local.plist',
    ])
    expect(env.folders).toEqual([
      ['/Users/me/.joy/logs', 0o700],
      ['/Users/me/Library/LaunchAgents', 0o755],
    ])
    expect(env.calls).toEqual([
      'launchctl bootout gui/501/com.joy.local',
      'launchctl bootstrap gui/501 /Users/me/Library/LaunchAgents/com.joy.local.plist',
    ])
    expect(env.lines.join('\n')).toContain('http://127.0.0.1:4317')
  })

  it('retries bootstrap while launchd is still unloading, then gives up with the reason', async () => {
    const flaky = fakeDeps({
      nodes: installedNode,
      results: (_command, args, call) => (args[0] === 'bootstrap' && call < 4 ? { status: 5 } : {}),
    })
    expect(await runService('install', serviceOptions, flaky.deps)).toBe(0)
    expect(flaky.sleeps()).toBe(2)
    const broken = fakeDeps({
      nodes: installedNode,
      results: (_command, args) =>
        args[0] === 'bootstrap' ? { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : {},
    })
    expect(await runService('install', serviceOptions, broken.deps)).toBe(1)
    expect(broken.sleeps()).toBe(3)
    expect(broken.lines.join('\n')).toContain('Bootstrap failed: 5')
    expect(broken.lines.join('\n')).toContain('uninstall')
  })

  it('stops before writing anything when there is no Node 22 or no node_modules', async () => {
    const noNode = fakeDeps({ nodes: { '/Users/me/Joy/node_modules/tsx': 'dir' } })
    expect(await runService('install', { ...serviceOptions, node: undefined }, noNode.deps)).toBe(1)
    expect(noNode.lines.join('\n')).toContain('brew install node@22')
    expect(noNode.written).toEqual([])
    const noModules = fakeDeps({ nodes: { '/opt/n22/bin/node': 'v22.14.0' } })
    expect(await runService('install', serviceOptions, noModules.deps)).toBe(1)
    expect(noModules.lines.join('\n')).toContain('pnpm install')
    expect(noModules.written).toEqual([])
  })

  it('warns when some other Joy answers on the port, but not when the installed service itself does', async () => {
    const other = fakeDeps({ nodes: installedNode, healthy: true, results: () => ({ status: 113 }) })
    await runService('install', { ...serviceOptions, dryRun: true }, other.deps)
    expect(other.lines.join('\n')).toContain('已經有 Joy 在回應')
    expect(other.lines.join('\n')).toContain('請先停掉那一個')
    const own = fakeDeps({ nodes: installedNode, healthy: true })
    await runService('install', { ...serviceOptions, dryRun: true }, own.deps)
    const output = own.lines.join('\n')
    expect(output).toContain('回應的是已安裝的服務')
    expect(output).not.toContain('請先停掉')
  })

  it('--dry-run of uninstall says exactly what it did not do', async () => {
    const env = fakeDeps({})
    await runService('uninstall', { ...serviceOptions, dryRun: true }, env.deps)
    expect(env.lines.join('\n')).toContain('--dry-run：沒有刪除設定檔，也沒有停止或移除服務。')
  })

  it('uninstall unloads the service and removes the file; a missing install is not an error', async () => {
    const plist = '/Users/me/Library/LaunchAgents/com.joy.local.plist'
    const env = fakeDeps({ files: { [plist]: 'x' } })
    expect(await runService('uninstall', serviceOptions, env.deps)).toBe(0)
    expect(env.calls).toEqual(['launchctl bootout gui/501/com.joy.local'])
    expect(env.files.has(plist)).toBe(false)
    const none = fakeDeps({ results: () => ({ status: 113 }) })
    expect(await runService('uninstall', serviceOptions, none.deps)).toBe(0)
    expect(none.lines.join('\n')).toContain('本來就沒有安裝')
    const dry = fakeDeps({ files: { [plist]: 'x' } })
    await runService('uninstall', { ...serviceOptions, dryRun: true }, dry.deps)
    expect(dry.calls).toEqual([])
    expect(dry.files.has(plist)).toBe(true)
  })

  it('systemd uninstall also reloads the units after removing the file', async () => {
    const env = fakeDeps({ files: { '/home/me/.config/systemd/user/joy-local.service': 'x' } })
    await runService(
      'uninstall',
      { ...serviceOptions, platform: 'linux', userHome: '/home/me', joyHome: '/home/me/.joy' },
      env.deps,
    )
    expect(env.calls).toEqual([
      'systemctl --user disable --now joy-local.service',
      'systemctl --user daemon-reload',
    ])
  })

  it('status reports file, manager and health, and exits 0 only when all three are fine', async () => {
    const plist = '/Users/me/Library/LaunchAgents/com.joy.local.plist'
    const running = fakeDeps({
      files: { [plist]: 'x' },
      healthy: true,
      results: () => ({ stdout: 'com.joy.local = {\n\tstate = running\n\tpid = 4242\n}' }),
    })
    expect(await runService('status', serviceOptions, running.deps)).toBe(0)
    const output = running.lines.join('\n')
    expect(output).toContain('已安裝')
    expect(output).toContain('已載入，running，pid 4242')
    expect(output).toContain('是，http://127.0.0.1:4317')
    const stopped = fakeDeps({ results: () => ({ status: 113 }) })
    expect(await runService('status', serviceOptions, stopped.deps)).toBe(1)
    expect(stopped.lines.join('\n')).toContain('未安裝')
    expect(stopped.lines.join('\n')).toContain('沒有載入')
  })

  it('status understands systemd and Task Scheduler answers', async () => {
    const linux = fakeDeps({
      files: { '/home/me/.config/systemd/user/joy-local.service': 'x' },
      healthy: true,
      results: () => ({
        stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=77\n',
      }),
    })
    const linuxOptions = { ...serviceOptions, platform: 'linux' as const, userHome: '/home/me' }
    expect(await runService('status', linuxOptions, linux.deps)).toBe(0)
    expect(linux.lines.join('\n')).toContain('active/running，開機設定 enabled，pid 77')
    const windows = fakeDeps({
      files: { 'C:\\Users\\me\\.joy\\service\\joy-local-task.xml': 'x' },
      healthy: true,
    })
    expect(
      await runService(
        'status',
        { ...serviceOptions, platform: 'win32', userHome: 'C:\\Users\\me', joyHome: 'C:\\Users\\me\\.joy' },
        windows.deps,
      ),
    ).toBe(0)
  })
})

describe('service install with the real file system and a fake runner', () => {
  it('writes the service file into a temp home and removes it again', async () => {
    const root = tempDir()
    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const repoRoot = join(root, 'Joy')
    const userHome = join(root, 'home')
    const joyHome = join(root, 'home', '.joy')
    mkdirSync(join(repoRoot, 'node_modules', 'tsx'), { recursive: true })
    const calls: string[] = []
    const lines: string[] = []
    // A Node 22 that "exists" outside the temp folder (explicit Node paths in temp folders are refused).
    const nodePath = platform === 'win32' ? 'C:\\nodes\\22\\node.exe' : '/opt/n22/bin/node'
    const real = realServiceDeps(
      (line) => lines.push(line),
      () => 'fresh',
    )
    const deps: ServiceDeps = {
      ...real,
      exists: (target) => target === nodePath || real.exists(target),
      run: async (command, args) => {
        calls.push([command, ...args].join(' '))
        return { status: 0, stdout: '', stderr: '' }
      },
      version: async () => 'v22.14.0',
      health: async () => false,
    }
    const options: ServiceOptions = {
      platform,
      userHome,
      joyHome,
      repoRoot,
      port: 4317,
      dryRun: false,
      node: nodePath,
      uid: 501,
      execPath: process.execPath,
      execVersion: process.version,
      env: { PATH: '/usr/bin' },
    }
    expect(await runService('install', options, deps)).toBe(0)
    const target =
      platform === 'win32'
        ? join(joyHome, 'service', 'joy-local-task.xml')
        : join(userHome, 'Library', 'LaunchAgents', 'com.joy.local.plist')
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(joyHome, 'logs'))).toBe(true)
    const bytes = readFileSync(target)
    if (platform === 'win32') {
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe])
      expect(bytes.subarray(2).toString('utf16le')).toContain(nodePath)
    } else {
      expect(bytes.toString('utf8')).toContain(nodePath)
    }
    expect(calls).toHaveLength(2)
    expect(await runService('uninstall', options, deps)).toBe(0)
    expect(existsSync(target)).toBe(false)
  })
})

describe('uiBuildState', () => {
  it('is missing without a build, stale when a source is newer, fresh otherwise', () => {
    const root = tempDir()
    const web = join(root, 'apps', 'web')
    mkdirSync(join(web, 'src'), { recursive: true })
    writeFileSync(join(web, 'src', 'main.tsx'), 'x')
    writeFileSync(join(web, 'index.html'), 'x')
    expect(uiBuildState(root)).toBe('missing')
    mkdirSync(join(web, 'dist'))
    writeFileSync(join(web, 'dist', 'index.html'), 'built')
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60_000)
    for (const file of [join(web, 'src', 'main.tsx'), join(web, 'index.html'), join(web, 'src')])
      utimesSync(file, past, past)
    expect(uiBuildState(root)).toBe('fresh')
    utimesSync(join(web, 'src', 'main.tsx'), future, future)
    expect(uiBuildState(root)).toBe('stale')
  })
})

describe('uiBuildState inputs', () => {
  const sources = [
    ['apps', 'web', 'src', 'main.tsx'],
    ['packages', 'core', 'src', 'index.ts'],
    ['packages', 'config', 'src', 'index.ts'],
  ]
  function builtRoot() {
    const root = tempDir()
    for (const parts of sources) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true })
    for (const parts of sources) writeFileSync(join(root, ...parts), 'x')
    mkdirSync(join(root, 'apps', 'web', 'dist'))
    writeFileSync(join(root, 'apps', 'web', 'dist', 'index.html'), 'built')
    const past = new Date(Date.now() - 60_000)
    for (const parts of sources) {
      utimesSync(join(root, ...parts), past, past)
      utimesSync(join(root, ...parts.slice(0, -1)), past, past)
    }
    return root
  }

  it('is stale when @joy/core or @joy/config changed, which the web app imports', () => {
    const future = new Date(Date.now() + 60_000)
    const root = builtRoot()
    expect(uiBuildState(root)).toBe('fresh')
    utimesSync(join(root, 'packages', 'core', 'src', 'index.ts'), future, future)
    expect(uiBuildState(root)).toBe('stale')
    const again = builtRoot()
    utimesSync(join(again, 'packages', 'config', 'src', 'index.ts'), future, future)
    expect(uiBuildState(again)).toBe('stale')
  })

  it.skipIf(process.platform === 'win32')('does not follow symlinks, so a loop cannot hang it', () => {
    const root = builtRoot()
    symlinkSync(join(root, 'apps', 'web', 'src'), join(root, 'apps', 'web', 'src', 'loop'))
    // Adding the link touched the folder; put its time back so only the symlink handling is under test.
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(root, 'apps', 'web', 'src'), past, past)
    expect(uiBuildState(root)).toBe('fresh')
  })
})
