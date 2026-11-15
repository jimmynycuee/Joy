import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderError, MAX_FOLDERS, initGitRepository, isNetworkPath, listFolders } from './folders.js'

let root: string
let home: string
let joyHome: string
let options: { home: string; joyHome: string }

beforeEach(() => {
  // realpath: the temp folder on macOS sits behind a /var -> /private/var link.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'joy-folders-')))
  home = join(root, 'home')
  joyHome = join(home, '.joy')
  mkdirSync(joyHome, { recursive: true })
  options = { home, joyHome }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const dir = (...parts: string[]) => {
  const path = join(home, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}
const names = async (path?: string) => (await listFolders(path, options)).folders.map((folder) => folder.name)
const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(FolderError)
    return error as FolderError
  }
  throw new Error('Expected a FolderError')
}

describe('listFolders', () => {
  it('lists only folders, sorted, from the home folder by default, and marks git repositories', async () => {
    dir('zeta')
    dir('alpha')
    dir('repo', '.git')
    dir('worktree')
    writeFileSync(join(home, 'worktree', '.git'), 'gitdir: /somewhere\n')
    writeFileSync(join(home, 'notes.txt'), 'secret contents')

    const listing = await listFolders(undefined, options)
    expect(listing.path).toBe(home)
    expect(listing.home).toBe(home)
    expect(listing.folders).toEqual([
      { name: 'alpha', path: join(home, 'alpha'), isGit: false },
      { name: 'repo', path: join(home, 'repo'), isGit: true },
      { name: 'worktree', path: join(home, 'worktree'), isGit: true },
      { name: 'zeta', path: join(home, 'zeta'), isGit: false },
    ])
    expect(listing.isGit).toBe(false)
    expect(listing.truncated).toBe(false)
    // No file name or content anywhere in the answer.
    expect(JSON.stringify(listing)).not.toContain('notes.txt')
    expect(JSON.stringify(listing)).not.toContain('secret contents')
  })

  it('goes down and up, says whether the folder itself is a repository, and gives a breadcrumb', async () => {
    dir('work', 'app', '.git')
    const listing = await listFolders(join(home, 'work', 'app'), options)
    expect(listing.isGit).toBe(true)
    expect(listing.parent).toBe(join(home, 'work'))
    expect(listing.crumbs.at(-1)).toEqual({ name: 'app', path: join(home, 'work', 'app') })
    expect(listing.crumbs.at(-2)).toEqual({ name: 'work', path: join(home, 'work') })
    expect(listing.crumbs[0]?.path).toBe(listing.crumbs[0]?.name)
    expect(listing.folders).toEqual([])
    // Up from home reaches the folder above it; the top has no parent.
    expect((await listFolders(home, options)).parent).toBe(root)
    expect((await listFolders('/', options)).parent).toBeNull()
  })

  it('understands ~ and ~/folder', async () => {
    dir('proj', 'inner')
    expect((await listFolders('~', options)).path).toBe(home)
    expect((await listFolders('~/proj', options)).path).toBe(join(home, 'proj'))
    expect(await names('~/proj')).toEqual(['inner'])
  })

  it('hides hidden folders, the home folder is the only place that treats Library and AppData as private', async () => {
    dir('visible')
    dir('.ssh')
    dir('.aws')
    dir('.config')
    dir('Library', 'Keychains')
    dir('AppData')
    dir('Documents', 'Library')
    expect(await names()).toEqual(['Documents', 'visible'])
    // Inside Documents a folder called Library is an ordinary folder.
    expect(await names(join(home, 'Documents'))).toEqual(['Library'])
  })

  it('refuses Joy data, hidden folders of the home folder, Library, AppData, and secret folders anywhere', async () => {
    dir('Library', 'Keychains')
    dir('AppData', 'Roaming')
    dir('.ssh')
    dir('.cache', 'deep')
    dir('project', '.aws')
    dir('project', '.gnupg')
    for (const path of [
      joyHome,
      join(joyHome, 'attachments'),
      join(home, '.ssh'),
      join(home, '.cache', 'deep'),
      join(home, 'Library'),
      join(home, 'Library', 'Keychains'),
      join(home, 'library'),
      join(home, 'AppData', 'Roaming'),
      join(home, 'project', '.aws'),
      join(home, 'project', '.gnupg'),
    ]) {
      if (!existsSync(path)) mkdirSync(path, { recursive: true })
      expect((await failure(listFolders(path, options))).status).toBe(403)
    }
    expect(await names(join(home, 'project'))).toEqual([])
  })

  it('refuses Joy data wherever it is, also outside the home folder', async () => {
    const elsewhere = join(root, 'elsewhere-joy')
    mkdirSync(join(elsewhere, 'logs'), { recursive: true })
    const custom = { home, joyHome: elsewhere }
    expect((await failure(listFolders(elsewhere, custom))).status).toBe(403)
    expect((await failure(listFolders(join(elsewhere, 'logs'), custom))).status).toBe(403)
    expect((await listFolders(root, custom)).folders.map((folder) => folder.name)).toEqual(['home'])
  })

  it('cannot be led around the list: `..`, links, and a link inside a folder', async () => {
    dir('project')
    dir('.ssh', 'keys')
    // Walking out of a visible folder into a hidden one.
    expect((await failure(listFolders(join(home, 'project', '..', '.ssh'), options))).status).toBe(403)
    expect((await failure(listFolders(`${home}/project/../.joy`, options))).status).toBe(403)
    expect((await failure(listFolders('~/project/../.ssh/keys', options))).status).toBe(403)
    // A link that points into a hidden folder is refused when asked for, and is not listed.
    symlinkSync(join(home, '.ssh'), join(home, 'project', 'innocent'))
    expect((await failure(listFolders(join(home, 'project', 'innocent'), options))).status).toBe(403)
    expect(await names(join(home, 'project'))).toEqual([])
    // A link to an ordinary folder is listed, and followed.
    dir('shared', 'nested')
    symlinkSync(join(home, 'shared'), join(home, 'project', 'link'))
    expect(await names(join(home, 'project'))).toEqual(['link'])
    expect((await listFolders(join(home, 'project', 'link'), options)).path).toBe(join(home, 'shared'))
    // A link to a file, and a broken link, are no folders.
    writeFileSync(join(home, 'a-file'), 'x')
    symlinkSync(join(home, 'a-file'), join(home, 'project', 'file-link'))
    symlinkSync(join(home, 'missing'), join(home, 'project', 'dead-link'))
    expect(await names(join(home, 'project'))).toEqual(['link'])
  })

  it('answers 400 for a path that is not absolute, has a NUL or is a file, and 404 for one that is not there', async () => {
    writeFileSync(join(home, 'a-file'), 'x')
    expect((await failure(listFolders('relative/path', options))).status).toBe(400)
    expect((await failure(listFolders('../escape', options))).status).toBe(400)
    expect((await failure(listFolders(`${home}/a\0b`, options))).status).toBe(400)
    expect((await failure(listFolders('x'.repeat(5000), options))).status).toBe(400)
    expect((await failure(listFolders(join(home, 'a-file'), options))).status).toBe(400)
    expect((await failure(listFolders(join(home, 'a-file', 'inside'), options))).status).toBe(400)
    expect((await failure(listFolders(join(home, 'nope'), options))).status).toBe(404)
  })

  it('refuses Windows network paths, for listing and for git init', async () => {
    for (const path of [
      '\\\\host\\share',
      '\\\\host\\share\\dir',
      '//host/share',
      '\\\\?\\C:\\dir',
      '\\\\.\\pipe',
    ]) {
      expect((await failure(listFolders(path, options))).status).toBe(400)
      expect((await failure(initGitRepository(path, options))).status).toBe(400)
    }
    expect(isNetworkPath('\\\\host\\share')).toBe(true)
    expect(isNetworkPath('//host/share')).toBe(true)
    expect(isNetworkPath('/home/me')).toBe(false)
    expect(isNetworkPath('C:\\Users')).toBe(false)
    expect(isNetworkPath('/')).toBe(false)
  })

  it('stops at 500 folders and says so', async () => {
    for (let index = 0; index < MAX_FOLDERS + 3; index++)
      mkdirSync(join(home, `f${String(index).padStart(4, '0')}`))
    const listing = await listFolders(undefined, options)
    expect(listing.folders).toHaveLength(MAX_FOLDERS)
    expect(listing.truncated).toBe(true)
  })
})

describe('initGitRepository', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('makes a repository on main with one commit, which a task can start from', async () => {
    const folder = dir('fresh')
    writeFileSync(join(folder, 'keep.txt'), 'mine')
    const result = await initGitRepository(folder, options)
    expect(result).toEqual({ path: folder, defaultBranch: 'main' })
    expect(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(folder, 'rev-parse', '--verify', 'main^{commit}')).toMatch(/^[0-9a-f]{40}$/)
    expect(git(folder, 'rev-list', '--count', 'HEAD')).toBe('1')
    // The folder's own files are left alone and uncommitted.
    expect(git(folder, 'status', '--porcelain')).toBe('?? keep.txt')
    expect((await listFolders(folder, options)).isGit).toBe(true)
  })

  /** A user whose git settings would get in the way: no identity, signing on, hooks from three places. */
  function hostileUser() {
    const userHome = join(root, 'user-home')
    const hooksDir = join(root, 'global-hooks')
    const template = join(root, 'template')
    mkdirSync(userHome, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    mkdirSync(join(template, 'hooks'), { recursive: true })
    const markers: string[] = []
    const hook = (dirPath: string, name: string) => {
      const marker = join(root, `ran-${markers.length}-${name}`)
      markers.push(marker)
      // A hook that leaves a mark and, for prepare-commit-msg, also rewrites the message.
      const body = name === 'prepare-commit-msg' ? `echo hooked > "$1"\n` : ''
      writeFileSync(join(dirPath, name), `#!/bin/sh\ntouch "${marker}"\n${body}exit 0\n`, { mode: 0o755 })
    }
    for (const name of ['prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-commit']) {
      hook(hooksDir, name)
      hook(join(template, 'hooks'), name)
    }
    writeFileSync(
      join(userHome, '.gitconfig'),
      `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hooksDir}\n[init]\n\ttemplateDir = ${template}\n`,
    )
    process.env.HOME = userHome
    process.env.XDG_CONFIG_HOME = join(userHome, '.config')
    process.env.USERPROFILE = userHome
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.GIT_CONFIG_GLOBAL
    return { markers }
  }

  it('does not need a git identity or care about commit signing', async () => {
    hostileUser()
    const folder = dir('no-identity')
    await initGitRepository(folder, options)
    expect(git(folder, 'log', '-1', '--format=%an')).toBe('Joy')
  })

  it.skipIf(process.platform === 'win32')(
    'runs no hook: not the owner’s global core.hooksPath, not the template’s, and the message stays',
    async () => {
      const { markers } = hostileUser()
      const folder = dir('hooked')
      // The template's hooks are copied into the new repository, as git does for everyone.
      await initGitRepository(folder, options)
      expect(existsSync(join(folder, '.git', 'hooks', 'post-commit'))).toBe(true)
      for (const marker of markers) expect(existsSync(marker)).toBe(false)
      expect(git(folder, 'log', '-1', '--format=%s')).toBe('Initial commit')
    },
  )

  it('works in the folder it was given when the process has GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_* set', async () => {
    hostileUser()
    const elsewhere = dir('elsewhere')
    process.env.GIT_DIR = join(elsewhere, '.git')
    process.env.GIT_WORK_TREE = elsewhere
    process.env.GIT_INDEX_FILE = join(elsewhere, 'index')
    process.env.GIT_OBJECT_DIRECTORY = join(elsewhere, 'objects')
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = 'user.name'
    process.env.GIT_CONFIG_VALUE_0 = 'Leaked'
    process.env.GIT_CONFIG_KEY_1 = 'user.email'
    process.env.GIT_CONFIG_VALUE_1 = 'leaked@example.com'
    process.env.GIT_CONFIG_GLOBAL = join(root, 'not-used')
    const folder = dir('target')
    await initGitRepository(folder, options)
    // The checks below run plain git, which must not see the variables above.
    process.env = { ...saved }
    expect(existsSync(join(folder, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(elsewhere, '.git'))).toBe(false)
    expect(existsSync(join(elsewhere, 'objects'))).toBe(false)
    expect(git(folder, 'log', '-1', '--format=%an <%ae>')).toBe('Joy <joy@localhost>')
  })

  it('refuses a repository that already exists, the home folder, the top of a drive, and off-limits places', async () => {
    dir('already', '.git')
    expect((await failure(initGitRepository(join(home, 'already'), options))).status).toBe(409)
    expect((await failure(initGitRepository(home, options))).status).toBe(400)
    expect((await failure(initGitRepository('~', options))).status).toBe(400)
    expect((await failure(initGitRepository('/', options))).status).toBe(400)
    dir('.ssh')
    expect((await failure(initGitRepository(join(home, '.ssh'), options))).status).toBe(403)
    expect((await failure(initGitRepository(joyHome, options))).status).toBe(403)
    expect(existsSync(join(home, '.ssh', '.git'))).toBe(false)
    writeFileSync(join(home, 'a-file'), 'x')
    expect((await failure(initGitRepository(join(home, 'a-file'), options))).status).toBe(400)
    expect((await failure(initGitRepository(join(home, 'missing'), options))).status).toBe(404)
    expect((await failure(initGitRepository('relative', options))).status).toBe(400)
  })

  it('refuses the folders above the home folder and above Joy data, which a repository would swallow', async () => {
    // home is <root>/home, Joy data <root>/home/.joy: <root> holds both.
    expect((await failure(initGitRepository(root, options))).status).toBe(400)
    expect(existsSync(join(root, '.git'))).toBe(false)
    // Joy data kept somewhere else: its parent is refused, a sibling of it is not.
    const data = join(root, 'elsewhere', 'joy-data')
    mkdirSync(data, { recursive: true })
    mkdirSync(join(root, 'elsewhere', 'project'))
    const custom = { home, joyHome: data }
    expect((await failure(initGitRepository(join(root, 'elsewhere'), custom))).status).toBe(400)
    expect(existsSync(join(root, 'elsewhere', '.git'))).toBe(false)
    expect((await initGitRepository(join(root, 'elsewhere', 'project'), custom)).defaultBranch).toBe('main')
    // A folder next to the home folder is just a folder.
    mkdirSync(join(root, 'other-project'))
    expect((await initGitRepository(join(root, 'other-project'), options)).defaultBranch).toBe('main')
  })
})
