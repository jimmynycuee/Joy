// Container mode (T4.5): an untrusted repository's agent runs inside `docker run`, seeing only its own worktree, the
// repository's git data and a dedicated CLI login folder — not the owner's home directory, other repositories or the
// host's CLI credentials. This module only builds the `docker` command line; the provider spawns it.
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

export type ContainerNetwork = 'host' | 'none'

export interface ContainerMount {
  host: string
  readOnly?: boolean
}

export interface ContainerRunInput {
  image: string
  /**
   * `host` lets the CLI reach its model API and Joy's local approval endpoint (Linux; Docker Desktop needs host
   * networking turned on). `none` cuts all network, so the CLI cannot reach its model; it is for offline checks.
   */
  network: ContainerNetwork
  /** The folder the CLI logs into inside the container (mounted as its HOME). Never the owner's real home. */
  containerHome: string
  /** Working directory; mounted read-write at the same path so paths in events match the host. */
  cwd: string
  mounts: ContainerMount[]
  /** The program inside the image, e.g. ['claude'] or ['node', '/path/fake-cli.mjs']. */
  command: string[]
  args: string[]
  /** `uid:gid` so files the agent writes keep the owner's ownership (POSIX hosts). */
  user?: string
  /** Run an init process as PID 1 so signals reach the command and its children are reaped. */
  init?: boolean
  /** Container name, so it can be `docker kill`ed when the run is stopped. */
  name?: string
}

export const CONTAINER_HOME = '/joy-home'

function assertPath(path: string, what: string): string {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path (got ${path})`)
  // A comma or newline would let a path inject extra --mount options.
  if (/[,\n\r]/.test(path)) throw new Error(`${what} contains a character Docker mounts cannot take: ${path}`)
  return path
}

/** The `docker run` command for one CLI run. Same paths inside and out; nothing else from the host is visible. */
export function containerRunCommand(input: ContainerRunInput): { command: string; args: string[] } {
  if (!/^[\w./:@-]+$/.test(input.image)) throw new Error(`Invalid container image name: ${input.image}`)
  if (input.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.name))
    throw new Error(`Invalid container name: ${input.name}`)
  const cwd = assertPath(input.cwd, 'The working directory')
  const seen = new Set<string>()
  const mounts: string[] = []
  const mount = (host: string, target: string, readOnly: boolean) => {
    if (seen.has(target)) return
    seen.add(target)
    mounts.push('--mount', `type=bind,source=${host},target=${target}${readOnly ? ',readonly' : ''}`)
  }
  mount(assertPath(input.containerHome, 'The container home'), CONTAINER_HOME, false)
  mount(cwd, cwd, false)
  for (const extra of input.mounts) {
    const path = assertPath(extra.host, 'A mounted path')
    mount(path, path, extra.readOnly ?? true)
  }
  return {
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      input.network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      ...(input.user ? ['--user', input.user] : []),
      ...(input.init ? ['--init'] : []),
      ...(input.name ? ['--name', input.name] : []),
      '--env',
      `HOME=${CONTAINER_HOME}`,
      ...mounts,
      '--workdir',
      cwd,
      input.image,
      ...input.command,
      ...input.args,
    ],
  }
}

/** The repository's shared git directory, which a linked worktree's `.git` file points into. */
/** Stops a named container (a stopped `docker run` client does not stop its container). Never throws. */
export function stopContainer(name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('docker', ['kill', name], { shell: false, windowsHide: true, timeout: 30_000 }, () => resolve())
  })
}

export function gitCommonDir(worktreePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreePath, shell: false, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout.trim())),
    )
  })
}
