import { homedir, tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Shell analysis for the `auto` and `full` permission modes.
 *
 * THIS IS A CONVENIENCE HEURISTIC, NOT A SECURITY BOUNDARY. It decides whether Joy asks the owner before an agent's
 * command runs; it reads the command's words and cannot know what a program does with them (`node -e`, a project
 * script, a test). The boundary is the CLI's own sandbox: Codex runs in its `workspace-write` sandbox (writes only in
 * the worktree, no network) and only asks Joy when it wants to step outside it; Claude Code only auto-accepts edits in
 * its working directory (the worktree; Joy never passes `--add-dir`). Anything this file cannot read with confidence
 * is reported as `outside`, so the owner is asked.
 *
 * Verdicts, from worst to best:
 * - `forbidden`: touches secrets, the keychain, credentials or Joy's own config. Always asks, in every mode.
 * - `outside`: may reach outside the worktree: a path elsewhere (other than the OS temp dir), network transfer,
 *   git remotes, a package not in the lockfile, an expansion or construct the analysis cannot follow.
 * - `inside`: every path it names resolves inside the worktree or the OS temp dir.
 */
export type ShellVerdict = 'inside' | 'outside' | 'forbidden'

export interface ShellAnalysis {
  verdict: ShellVerdict
  /** Why, for the owner (empty when inside). */
  reason: string
}

/** Where things are on this computer. Injectable so tests do not depend on the machine they run on. */
export interface ClassifyEnvironment {
  /** The owner's home directory (`~`). */
  home: string
  /** Directories where scratch files are fine (the OS temp dir). */
  tempDirs: readonly string[]
  /** Joy's own data directory (JOY_HOME, default ~/.joy): config, database, attachments. Always forbidden. */
  joyHome?: string
  /**
   * Other spellings of the same directory (Windows 8.3 short names like `RUNNER~1` and their long form, a resolved
   * symbolic link). Paths are only compared as text, so each spelling must be listed.
   */
  joyHomeAliases?: readonly string[]
  /**
   * The OS the agent's commands run on. On Windows every path is compared with Windows rules (drive letters, `\`,
   * case-insensitive), whatever the worktree string looks like. Default: this process's platform.
   */
  platform?: NodeJS.Platform
}

export function defaultClassifyEnvironment(): ClassifyEnvironment {
  const temp = tmpdir()
  // macOS: tmpdir() is /var/folders/…/T, and /tmp is a link to /private/tmp; both are scratch space.
  const tempDirs = process.platform === 'win32' ? [temp] : [temp, '/tmp', '/private/tmp', '/var/tmp']
  return {
    home: homedir(),
    tempDirs,
    platform: process.platform,
    ...(process.env.JOY_HOME ? { joyHome: process.env.JOY_HOME } : {}),
  }
}

/**
 * Home-relative locations that hold credentials or Joy's own state. Reaching them is `forbidden` in every mode.
 * Written with `/`; Windows paths are compared after turning `\` into `/`.
 */
const SECRET_HOME_PATHS = [
  '.joy',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.docker',
  '.password-store',
  '.config/gh',
  '.config/gcloud',
  '.config/joy',
  '.local/share/keyrings',
  // The CLIs' own logins (subscription credentials Joy must never read).
  '.claude',
  '.claude.json',
  '.codex',
  'Library/Keychains',
]
/** Directory names that mean "credentials" wherever they appear (another user's home, an expanded variable). */
const SECRET_SEGMENTS = new Set([
  '.joy',
  '.ssh',
  '.gnupg',
  '.aws',
  '.git-credentials',
  '.netrc',
  '.password-store',
  'Keychains',
])
const SYSTEM_SECRET_PATHS = ['/Library/Keychains', '/etc/shadow', '/etc/sudoers', '/private/etc/sudoers']
/** Environment variables whose value is likely a credential. */
const SECRET_VARIABLE =
  /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)\w*$|^(?:AWS|GH|GITHUB|OPENAI|ANTHROPIC)_/i

/** Programs that read or change secrets, keychains or logins. */
const SECRET_PROGRAMS = new Set([
  'security',
  'secret-tool',
  'cmdkey',
  'keyctl',
  'ssh-add',
  'ssh-keygen',
  'ssh-agent',
  'gpg',
  'gpg2',
  'gpg-agent',
  'op',
  'pass',
  'gopass',
  'bw',
  'lpass',
  'vault',
  'keychain',
])

/** Programs whose job is to move data over the network or to another machine. */
const NETWORK_PROGRAMS = new Set([
  'curl',
  'wget',
  'aria2c',
  'http',
  'https',
  'xh',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'tftp',
  'telnet',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'gh',
  'hub',
  'glab',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  'kubectl',
  'helm',
  'docker',
  'podman',
  'npx',
  'pnpx',
  'bunx',
  'brew',
  'apt',
  'apt-get',
  'dnf',
  'yum',
  'pacman',
  'apk',
  'snap',
  'winget',
  'choco',
  'scoop',
  'pipx',
  'Invoke-WebRequest',
  'Invoke-RestMethod',
  'iwr',
  'irm',
  'certutil',
  'bitsadmin',
])

/** Programs that change the machine itself, other processes or the owner's session. */
const SYSTEM_PROGRAMS = new Set([
  'sudo',
  'doas',
  'su',
  'runas',
  'eval',
  'open',
  'xdg-open',
  'osascript',
  'defaults',
  'launchctl',
  'systemctl',
  'service',
  'crontab',
  'at',
  'shutdown',
  'reboot',
  'halt',
  'mount',
  'umount',
  'diskutil',
  'chflags',
  'killall',
  'pkill',
  'reg',
  'setx',
  'schtasks',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
])

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
/** Interpreters that read a program from stdin when given no script. */
const INTERPRETERS = new Set([...SHELLS, 'node', 'python', 'python3', 'perl', 'ruby', 'php', 'deno', 'bun'])
/** Words that start or end a compound command; the command that follows is analyzed on its own. */
const KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'time',
  'esac',
  'in',
])
/** Programs that run the rest of their arguments as a command. */
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'stdbuf', 'caffeinate'])
/** Programs that only read: fine after `xargs`, whose arguments come from stdin and cannot be checked. */
const READ_ONLY_PROGRAMS = new Set([
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'wc',
  'ls',
  'file',
  'stat',
  'echo',
  'printf',
  'sort',
  'uniq',
  'basename',
  'dirname',
  'du',
])
const DEVICES = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/tty',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
])

// ---------------------------------------------------------------------------------------------------------------
// Tokenizer

interface Word {
  /** The word after quote removal, as the program will see it (when it does not expand). */
  value: string
  /** Contains `$…`, a backtick or a process substitution: its value is only known when the shell runs. */
  expands: boolean
  /** Text of every command substitution inside the word, analyzed as commands of their own. */
  substitutions: string[]
  /** Refers to a named variable (`$HOME`, `${X}`), not only to `$?`-style parameters or command substitutions. */
  variables: boolean
  /** A here-document delimiter that was quoted: its body is literal. */
  quotedDelimiter?: boolean
}

type Token =
  | { type: 'word'; word: Word }
  | { type: 'op'; op: string }
  | { type: 'heredoc'; body: string; expands: boolean }

class Unparseable extends Error {}

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '(', ')']
const REDIRECTS = ['<<<', '<<-', '&>>', '<<', '>>', '>|', '<>', '>&', '<&', '&>', '>', '<']

/**
 * `windows`: the agent's shell is PowerShell or cmd, where `\` separates paths instead of escaping. Treating it as
 * literal there is also the conservative reading for Git Bash: the path stays visible to the checks.
 */
function tokenize(source: string, windows = false): Token[] {
  const tokens: Token[] = []
  const pendingHeredocs: { delimiter: string; stripTabs: boolean; quoted: boolean }[] = []
  let i = 0
  let current: Word | undefined
  let awaitingDelimiter: { stripTabs: boolean } | undefined

  const word = () => (current ??= { value: '', expands: false, substitutions: [], variables: false })
  const flush = () => {
    if (!current) return
    if (awaitingDelimiter) {
      pendingHeredocs.push({
        delimiter: current.value,
        stripTabs: awaitingDelimiter.stripTabs,
        quoted: current.quotedDelimiter ?? false,
      })
      awaitingDelimiter = undefined
    }
    tokens.push({ type: 'word', word: current })
    current = undefined
  }
  /** Reads `$( … )` or `` ` … ` `` up to its end, keeping nested quotes and parentheses together. */
  const readBalanced = (open: string, close: string): string => {
    let depth = 1
    let text = ''
    while (i < source.length) {
      const ch = source[i] as string
      if (ch === '\\' && open !== '`') {
        text += ch + (source[i + 1] ?? '')
        i += 2
        continue
      }
      if (ch === "'" && open !== '`') {
        const end = source.indexOf("'", i + 1)
        if (end < 0) throw new Unparseable('unterminated quote')
        text += source.slice(i, end + 1)
        i = end + 1
        continue
      }
      if (ch === close && open !== close) depth -= 1
      else if (ch === open && open !== close) depth += 1
      else if (ch === close) depth = 0
      i += 1
      if (depth === 0) return text
      text += ch
    }
    throw new Unparseable('unterminated substitution')
  }
  const readDollar = (target: Word) => {
    target.expands = true
    const next = source[i + 1]
    if (next === '(') {
      i += 2
      const inner = readBalanced('(', ')')
      // `$(( … ))` is arithmetic, not a command.
      if (!inner.startsWith('(')) target.substitutions.push(inner)
      target.value += '$(…)'
      return
    }
    if (next === '{') {
      const end = source.indexOf('}', i + 2)
      if (end < 0) throw new Unparseable('unterminated ${')
      target.value += source.slice(i, end + 1)
      target.variables = true
      i = end + 1
      return
    }
    const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])?/.exec(source.slice(i))
    if (match && /^\$[A-Za-z_]/.test(match[0])) target.variables = true
    target.value += match?.[0] ?? '$'
    i += match?.[0].length ?? 1
  }

  while (i < source.length) {
    const ch = source[i] as string
    if (ch === ' ' || ch === '\t') {
      flush()
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') {
      flush()
      i += 1
      if (ch === '\r' && source[i] === '\n') i += 1
      // Bodies of here-documents start on the next line, in the order they were opened.
      for (const doc of pendingHeredocs.splice(0)) {
        let body = ''
        let closed = false
        while (i < source.length) {
          const end = source.indexOf('\n', i)
          const rawLine = source.slice(i, end < 0 ? source.length : end).replace(/\r$/, '')
          i = end < 0 ? source.length : end + 1
          const line = doc.stripTabs ? rawLine.replace(/^\t+/, '') : rawLine
          if (line === doc.delimiter) {
            closed = true
            break
          }
          body += `${line}\n`
        }
        if (!closed) throw new Unparseable('unterminated here-document')
        tokens.push({ type: 'heredoc', body, expands: !doc.quoted && /[$`]/.test(body) })
      }
      tokens.push({ type: 'op', op: ';' })
      continue
    }
    if (ch === '#' && !current) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    if (ch === '\\' && !windows) {
      const next = source[i + 1]
      if (next === '\n') {
        i += 2
        continue
      }
      if (next === undefined) throw new Unparseable('trailing backslash')
      word().value += next
      i += 2
      continue
    }
    if (ch === "'") {
      const end = source.indexOf("'", i + 1)
      if (end < 0) throw new Unparseable('unterminated quote')
      const w = word()
      w.value += source.slice(i + 1, end)
      if (awaitingDelimiter) w.quotedDelimiter = true
      i = end + 1
      continue
    }
    if (ch === '"') {
      const w = word()
      if (awaitingDelimiter) w.quotedDelimiter = true
      i += 1
      let closed = false
      while (i < source.length) {
        const c = source[i] as string
        if (c === '"') {
          closed = true
          i += 1
          break
        }
        if (c === '\\' && !windows && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1] as string)) {
          if (source[i + 1] !== '\n') w.value += source[i + 1]
          i += 2
          continue
        }
        if (c === '$') {
          readDollar(w)
          continue
        }
        if (c === '`') {
          i += 1
          w.expands = true
          w.substitutions.push(readBalanced('`', '`'))
          w.value += '`…`'
          continue
        }
        w.value += c
        i += 1
      }
      if (!closed) throw new Unparseable('unterminated quote')
      continue
    }
    if (ch === '$') {
      readDollar(word())
      continue
    }
    const cmdVariable = windows ? /^%[A-Za-z_][A-Za-z0-9_()]*%/.exec(source.slice(i)) : null
    if (cmdVariable) {
      // cmd's `%USERPROFILE%`: an expansion like `$HOME`.
      const w = word()
      w.expands = true
      w.variables = true
      w.value += cmdVariable[0]
      i += cmdVariable[0].length
      continue
    }
    if (ch === '`') {
      i += 1
      const w = word()
      w.expands = true
      w.substitutions.push(readBalanced('`', '`'))
      w.value += '`…`'
      continue
    }
    if ((ch === '<' || ch === '>') && source[i + 1] === '(') {
      // Process substitution: a command whose output (or input) becomes a file name.
      i += 2
      const w = word()
      w.expands = true
      w.substitutions.push(readBalanced('(', ')'))
      w.value += '<(…)'
      continue
    }
    const redirect = REDIRECTS.find((r) => source.startsWith(r, i))
    if (redirect) {
      // `2>` `2>>` `2>&1`: a word made only of digits right before is the file descriptor, not an argument.
      if (current && /^\d+$/.test(current.value) && !current.expands) current = undefined
      else flush()
      tokens.push({ type: 'op', op: redirect })
      i += redirect.length
      if (redirect === '<<' || redirect === '<<-') awaitingDelimiter = { stripTabs: redirect === '<<-' }
      continue
    }
    const operator = OPERATORS.find((o) => source.startsWith(o, i))
    if (operator) {
      flush()
      tokens.push({ type: 'op', op: operator })
      i += operator.length
      continue
    }
    word().value += ch
    i += 1
  }
  flush()
  if (pendingHeredocs.length) throw new Unparseable('unterminated here-document')
  return tokens
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis

interface Context {
  worktree: string
  /** Every directory a command may run in (a failed or piped `cd` leaves the old one in effect, so keep both). */
  cwds: Set<string>
  /** A `cd` went somewhere the analysis cannot resolve (full mode only; auto stops there). */
  unknownCwd: boolean
  /** The command being analyzed runs only if the one before succeeded, and the next only if it succeeds. */
  cdReplaces: boolean
  /** `\` is a literal character (cmd/PowerShell), not a shell escape (Git Bash, POSIX). */
  literalBackslash: boolean
  env: ClassifyEnvironment
  depth: number
  path: typeof posix
}

class Verdict {
  verdict: ShellVerdict = 'inside'
  reason = ''
  /** Every reason raised, not only the one reported (`analyzeShellConcerns`). */
  readonly raised = new Set<string>()
  raise(verdict: Exclude<ShellVerdict, 'inside'>, reason: string) {
    this.raised.add(reason)
    if (this.verdict === 'forbidden') return
    if (verdict === 'forbidden' || this.verdict === 'inside') {
      this.verdict = verdict
      this.reason = reason
    }
  }
}

const REASONS = {
  secret: 'touches secrets, credentials or Joy\u2019s own config',
  network: 'downloads from or uploads to the network',
  outsidePath: 'names a path outside the worktree',
  expansion: 'uses an expansion whose value is only known when it runs',
  unparseable: 'could not be read reliably',
  system: 'changes the system, other processes or runs code that cannot be checked',
  git: 'changes git remotes or talks to them',
  packages: 'installs a package that is not in the lockfile, or publishes',
  cd: 'changes to a directory outside the worktree',
} as const

/**
 * Windows rules on Windows, and for a Windows-looking worktree anywhere (so tests behave the same on every OS).
 * Choosing by the worktree string alone was wrong: on Windows a worktree given as `/fake/x` fell back to POSIX rules,
 * where `\` is an escape, so `C:\…\config.yaml` under JOY_HOME was read as a harmless relative word.
 */
function pathFor(worktree: string, env: ClassifyEnvironment): typeof posix {
  if (env.platform === 'win32') return win32
  return /^[A-Za-z]:[\\/]/.test(worktree) || worktree.startsWith('\\\\') ? win32 : posix
}

/** Every spelling of JOY_HOME, without a trailing separator. */
function joyHomes(env: ClassifyEnvironment): string[] {
  return [env.joyHome, ...(env.joyHomeAliases ?? [])].filter(
    (dir): dir is string => typeof dir === 'string' && dir.trim() !== '',
  )
}

function within(path: typeof posix, root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function runAnalysis(
  command: string,
  options: { cwd: string; worktree: string; mode: 'auto' | 'full'; env?: ClassifyEnvironment },
): Verdict {
  const env = options.env ?? defaultClassifyEnvironment()
  const path = pathFor(options.worktree, env)
  const ctx: Context = {
    worktree: path.resolve(options.worktree),
    cwds: new Set([path.resolve(options.worktree, options.cwd)]),
    unknownCwd: false,
    cdReplaces: false,
    literalBackslash: path === win32,
    env,
    depth: 0,
    path,
  }
  const result = new Verdict()
  if (command.trim() === '') result.raise('outside', REASONS.unparseable)
  else {
    analyzeScript(command, ctx, options.mode, result)
    // On Windows the same text means different things: cmd/PowerShell keep `\` (paths), Git Bash (where Claude Code
    // runs its Bash tool) drops it as an escape, so `cu\rl` runs curl. Judge both readings and keep the stricter
    // one (one Verdict collects both, and it only ever gets worse).
    if (path === win32 && command.includes('\\'))
      analyzeScript(
        command,
        {
          ...ctx,
          cwds: new Set([path.resolve(options.worktree, options.cwd)]),
          unknownCwd: false,
          cdReplaces: false,
          literalBackslash: false,
        },
        options.mode,
        result,
      )
  }
  return result
}

/**
 * Judges one shell command run with `cwd` (inside `worktree`). `mode` only changes how unknown expansions are
 * treated: `auto` asks, `full` lets them through unless they name a secret.
 */
export function analyzeShellCommand(
  command: string,
  options: { cwd: string; worktree: string; mode: 'auto' | 'full'; env?: ClassifyEnvironment },
): ShellAnalysis {
  const result = runAnalysis(command, options)
  return { verdict: result.verdict, reason: result.reason }
}

/** Why a command may leave the worktree. Every concern found is listed, not only the first one. */
export type ShellConcern = keyof typeof REASONS

/**
 * Like `analyzeShellCommand`, plus every concern the command raised. The verdict reports one reason; a command such as
 * `rm ../x && git push` has two, and a caller deciding whether an approval may be remembered needs to see both.
 */
export function analyzeShellConcerns(
  command: string,
  options: { cwd: string; worktree: string; mode: 'auto' | 'full'; env?: ClassifyEnvironment },
): ShellAnalysis & { concerns: ShellConcern[] } {
  const result = runAnalysis(command, options)
  const concerns = (Object.keys(REASONS) as ShellConcern[]).filter((key) => result.raised.has(REASONS[key]))
  return { verdict: result.verdict, reason: result.reason, concerns }
}

/**
 * Names in `SECRET_HOME_PATHS` that projects also keep in their own tree (`.claude/settings.json`, `.npmrc`,
 * `.docker/`). A search that starts in the worktree and cannot climb out of it reads the project's copy, not the
 * home directory's, so naming one of these there does not ask.
 */
const PROJECT_CONFIG_NAMES = new Set([
  '.claude',
  '.claude.json',
  '.codex',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.docker',
])

/** Glob characters: a directory segment with one of them can match any directory, secrets included. */
const GLOB_CHARS = /[*?[\]{}]/

/**
 * Judges a file search (Claude's Grep and Glob), which reads many files from one call: `root` is where it starts
 * (relative to the worktree), `patterns` the path globs it uses, `recursive` whether it descends below `root` by itself
 * (Grep always does). Forbidden when a pattern names a secret, when a pattern resolves into one, or when the search may
 * descend from a directory that holds a secret (the home directory, JOY_HOME's parent, `/`) into it.
 */
export function analyzeSearch(
  root: string,
  patterns: readonly string[],
  options: { worktree: string; mode: 'auto' | 'full'; recursive: boolean; env?: ClassifyEnvironment },
): ShellAnalysis {
  const env = options.env ?? defaultClassifyEnvironment()
  const path = pathFor(options.worktree, env)
  const worktree = path.resolve(options.worktree)
  const ctx: Context = {
    worktree,
    cwds: new Set([worktree]),
    unknownCwd: false,
    cdReplaces: false,
    literalBackslash: path === win32,
    env,
    depth: 0,
    path,
  }
  const result = new Verdict()
  const start = path.resolve(worktree, root)
  checkResolvedPath(start, ctx, options.mode, result, REASONS.outsidePath)
  const fold = (value: string) => (path === win32 ? value.toLowerCase() : value)
  // A secret named anywhere in a pattern (`**/.ssh/*`, `.config/gh/**`), wherever the search starts.
  const secretSequences = [...SECRET_HOME_PATHS, ...SECRET_SEGMENTS].map((p) => p.split('/').map(fold))
  const projectConfig = new Set([...PROJECT_CONFIG_NAMES].map(fold))
  const startsInWorktree = within(path, worktree, start)
  let descends = options.recursive
  for (const pattern of patterns) {
    if (pattern.trim() === '') continue
    const normalized = pattern.replace(/\\/g, '/')
    const segments = normalized.split('/').filter(Boolean).map(fold)
    // `..`, an absolute pattern or `~` can leave the worktree, so the project's copy is not all such a pattern reaches.
    const staysInWorktree =
      startsInWorktree && !normalized.includes('..') && !normalized.includes('~') && !path.isAbsolute(pattern)
    const sequences = staysInWorktree
      ? secretSequences.filter((sequence) => !(sequence.length === 1 && projectConfig.has(sequence[0] ?? '')))
      : secretSequences
    const named = sequences.some((sequence) =>
      segments.some((_, i) => sequence.every((part, j) => segments[i + j] === part)),
    )
    if (named) result.raise('forbidden', REASONS.secret)
    checkResolvedPath(path.resolve(start, pattern), ctx, options.mode, result, REASONS.outsidePath)
    if (pattern.includes('**') || segments.slice(0, -1).some((segment) => GLOB_CHARS.test(segment)))
      descends = true
  }
  if (descends && !within(path, worktree, start)) {
    const home = path.resolve(env.home)
    const secrets = [
      ...joyHomes(env).map((dir) => path.resolve(dir)),
      ...SECRET_HOME_PATHS.map((p) => path.resolve(home, p)),
      ...(path === win32 ? [] : SYSTEM_SECRET_PATHS),
    ]
    if (secrets.some((secret) => within(path, start, secret) && !within(path, worktree, secret)))
      result.raise('forbidden', REASONS.secret)
  }
  return { verdict: result.verdict, reason: result.reason }
}

function analyzeScript(source: string, ctx: Context, mode: 'auto' | 'full', result: Verdict): void {
  if (ctx.depth > 4) return result.raise('outside', REASONS.unparseable)
  let tokens: Token[]
  try {
    tokens = tokenize(source, ctx.literalBackslash)
  } catch {
    // Still look for secrets in what could not be parsed, so `full` cannot be talked past with a stray quote.
    scanText(source, ctx, mode, result)
    return result.raise('outside', REASONS.unparseable)
  }
  let words: Word[] = []
  let redirects: { op: string; target?: Word }[] = []
  let heredoc: { body: string; expands: boolean } | undefined
  let pipedInto = false
  let previousOp: string | undefined
  const scopes: { cwds: Set<string>; unknownCwd: boolean }[] = []
  const finish = (nextOp: string | undefined) => {
    if (words.length || redirects.length) {
      // `cd x && rm y` runs `rm` in x only. After `;`, `||`, a pipe or `&`, a failed or subshell `cd` leaves the old
      // directory in effect, so both stay possible.
      ctx.cdReplaces =
        nextOp === '&&' && !pipedInto && previousOp !== '||' && previousOp !== '&' && previousOp !== '|'
      analyzeSimpleCommand(words, redirects, heredoc, pipedInto, ctx, mode, result)
    }
    if (nextOp === '(') scopes.push({ cwds: new Set(ctx.cwds), unknownCwd: ctx.unknownCwd })
    if (nextOp === ')') {
      // A subshell's `cd` ends with it; the directories before it are back (keeping any added ones is only stricter,
      // but a stale inner directory would make `..` look further inside than it is).
      const scope = scopes.pop()
      if (scope) {
        ctx.cwds = scope.cwds
        ctx.unknownCwd = scope.unknownCwd
      }
    }
    if (nextOp !== undefined && nextOp !== '(' && nextOp !== ')') previousOp = nextOp
    pipedInto = nextOp === '|' || nextOp === '|&'
    words = []
    redirects = []
    heredoc = undefined
  }
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k] as Token
    if (token.type === 'heredoc') {
      // The body is data for the command it belongs to, which has already been analyzed; check it for paths.
      scanText(token.body, ctx, mode, result)
      if (token.expands) {
        if (mode === 'auto') result.raise('outside', REASONS.expansion)
      }
      continue
    }
    if (token.type === 'word') {
      words.push(token.word)
      continue
    }
    if (REDIRECTS.includes(token.op)) {
      const next = tokens[k + 1]
      const target = next?.type === 'word' ? next.word : undefined
      if (target) k += 1
      else return result.raise('outside', REASONS.unparseable)
      redirects.push({ op: token.op, target })
      if (token.op === '<<' || token.op === '<<-') heredoc = { body: '', expands: false }
      continue
    }
    finish(token.op)
  }
  finish(undefined)
}

function analyzeSimpleCommand(
  allWords: Word[],
  redirects: { op: string; target?: Word }[],
  heredoc: { body: string; expands: boolean } | undefined,
  pipedInto: boolean,
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
): void {
  for (const word of allWords) for (const sub of word.substitutions) analyzeNested(sub, ctx, mode, result)
  for (const { op, target } of redirects) {
    if (!target) continue
    for (const sub of target.substitutions) analyzeNested(sub, ctx, mode, result)
    // `2>&1`, `>&2`, `<&0`, `>&-`: file descriptors, not files. Here-doc delimiters and here-strings are data.
    if ((op === '>&' || op === '<&') && /^(?:\d+|-)$/.test(target.value)) continue
    if (op === '<<' || op === '<<-') continue
    if (op === '<<<') {
      scanText(target.value, ctx, mode, result)
      continue
    }
    checkPathWord(target, ctx, mode, result, { redirect: true })
  }

  let words = [...allWords]
  // Leading keywords of compound commands (`if`, `do`, `!`, `{`): the command after them is what runs.
  while (words[0] && !words[0].expands && KEYWORDS.has(words[0].value)) words = words.slice(1)
  const first = words[0]
  if (!first) return
  if (!first.expands && (first.value === 'for' || first.value === 'case' || first.value === 'select')) {
    // `for x in a b` / `case $x in`: the words are data; still check them as paths.
    for (const word of words.slice(1)) checkPathWord(word, ctx, mode, result)
    return
  }
  // `NAME=value cmd`: the value can be a path (`GIT_DIR=/elsewhere git …`).
  while (words[0] && !words[0].expands && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) {
    checkAssignment(words[0], ctx, mode, result)
    words = words.slice(1)
  }
  if (!words.length) return
  analyzeProgram(words, heredoc !== undefined, pipedInto, ctx, mode, result)
}

function analyzeNested(source: string, ctx: Context, mode: 'auto' | 'full', result: Verdict) {
  analyzeScript(source, { ...ctx, cwds: new Set(ctx.cwds), depth: ctx.depth + 1 }, mode, result)
}

function analyzeProgram(
  words: Word[],
  hasHeredoc: boolean,
  pipedInto: boolean,
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
): void {
  const [programWord, ...rest] = words as [Word, ...Word[]]
  if (programWord.expands) {
    scanWord(programWord, ctx, result)
    if (mode === 'auto') result.raise('outside', REASONS.expansion)
    for (const word of rest) checkPathWord(word, ctx, mode, result)
    return
  }
  let program = programWord.value
  if (/[\\/]/.test(program)) {
    // `./scripts/x.sh` runs a project file; `/usr/bin/git` is just git.
    const resolved = resolveWord(program, ctx)
    if (resolved.kind === 'paths' && resolved.paths.every((p) => isInsideAllowed(p, ctx))) {
      checkPathWord(programWord, ctx, mode, result)
      for (const word of rest) checkPathWord(word, ctx, mode, result)
      return
    }
    const base = ctx.path.basename(program.replace(/\\/g, '/'))
    const systemBin = /^(?:\/usr)?(?:\/local)?\/s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/.test(program)
    if (!systemBin) {
      checkPathWord(programWord, ctx, mode, result)
      result.raise('outside', REASONS.outsidePath)
      return
    }
    program = base
  }
  const name = program.replace(/\.exe$/i, '')
  const args = rest

  if (SECRET_PROGRAMS.has(name)) return result.raise('forbidden', REASONS.secret)
  // Look for secrets in every argument first: `full` lets most other things through.
  for (const word of args) scanWord(word, ctx, result)

  if (WRAPPERS.has(name)) return analyzeWrapped(args, hasHeredoc, pipedInto, ctx, mode, result)
  if (name === 'env') {
    let k = 0
    while (k < args.length) {
      const arg = args[k] as Word
      if (arg.value === '-i' || arg.value === '-0' || arg.value === '--ignore-environment') k += 1
      else if (arg.value === '-u' || arg.value === '--unset') k += 2
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg.value)) {
        checkAssignment(arg, ctx, mode, result)
        k += 1
      } else if (arg.value.startsWith('-')) {
        return result.raise('outside', REASONS.unparseable)
      } else break
    }
    const inner = args.slice(k)
    if (inner.length) analyzeProgram(inner, hasHeredoc, pipedInto, ctx, mode, result)
    return
  }
  if (name === 'timeout' || name === 'nice' || name === 'time') {
    let k = 0
    while (k < args.length && (args[k] as Word).value.startsWith('-')) {
      // `nice -n 10`, `timeout -s KILL 5`, `timeout -k 2 5`: the flag takes the next word.
      k += /^-(?:n|s|k)$/.test((args[k] as Word).value) ? 2 : 1
    }
    if (name === 'timeout') k += 1
    const inner = args.slice(k)
    if (inner.length) analyzeProgram(inner, hasHeredoc, pipedInto, ctx, mode, result)
    return
  }
  if (name === 'xargs') {
    let k = 0
    while (k < args.length && (args[k] as Word).value.startsWith('-')) {
      k += /^-(?:I|L|n|P|d|E|s|a)$/.test((args[k] as Word).value) ? 2 : 1
    }
    const inner = args.slice(k)
    const innerName = inner[0]?.value
    // xargs' arguments come from stdin and cannot be checked; only a read-only program is fine.
    if (!innerName || inner[0]?.expands || !READ_ONLY_PROGRAMS.has(innerName)) {
      if (mode === 'auto') result.raise('outside', REASONS.unparseable)
    }
    if (inner.length) analyzeProgram(inner, hasHeredoc, pipedInto, ctx, mode, result)
    return
  }
  if (SHELLS.has(name)) return analyzeShellInvocation(args, hasHeredoc, pipedInto, ctx, mode, result)
  if (name === 'source' || name === '.') {
    for (const word of args) checkPathWord(word, ctx, mode, result)
    return
  }
  if (NETWORK_PROGRAMS.has(name)) {
    for (const word of args) checkPathWord(word, ctx, mode, result)
    return result.raise('outside', REASONS.network)
  }
  if (SYSTEM_PROGRAMS.has(name)) return result.raise('outside', REASONS.system)
  if (name === 'kill') {
    // `kill %1` stops a background job of this shell; a pid could be anything, Joy included.
    if (!args.every((a) => /^%\d*$|^-\w+$/.test(a.value))) result.raise('outside', REASONS.system)
    return
  }
  if (name === 'cd' || name === 'pushd') return changeDirectory(args, ctx, mode, result)
  if (name === 'popd') return
  if (name === 'git') return analyzeGit(args, ctx, mode, result)
  if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') {
    analyzePackageManager(name, args, ctx, mode, result)
    return
  }
  if (name === 'pip' || name === 'pip3' || name === 'uv' || name === 'poetry' || name === 'conda') {
    if (
      args.some((a) =>
        ['install', 'add', 'upgrade', 'download', 'publish', 'upload', 'sync', 'lock', 'update'].includes(
          a.value,
        ),
      )
    )
      result.raise('outside', REASONS.packages)
  }
  if (
    name === 'cargo' &&
    ['install', 'publish', 'login', 'owner', 'yank', 'search'].includes(args[0]?.value ?? '')
  )
    result.raise('outside', REASONS.packages)
  if (name === 'go' && ['get', 'install'].includes(args[0]?.value ?? ''))
    result.raise('outside', REASONS.packages)
  if (name === 'gem' && ['install', 'push', 'update', 'signin'].includes(args[0]?.value ?? ''))
    result.raise('outside', REASONS.packages)
  if (INTERPRETERS.has(name)) {
    // `python3 -m pip install x` is pip.
    const moduleIndex = args.findIndex((a) => a.value === '-m')
    if (moduleIndex >= 0 && /^pip3?$/.test(args[moduleIndex + 1]?.value ?? '')) {
      if (args.slice(moduleIndex + 2).some((a) => ['install', 'download', 'uninstall'].includes(a.value)))
        result.raise('outside', REASONS.packages)
    }
    // No script and no inline code: the program comes from stdin, which cannot be checked unless it is a here-doc.
    const hasCode = args.some(
      (a) => !a.value.startsWith('-') || /^-(?:c|e|p|m)$|^--eval$|^--print$/.test(a.value),
    )
    if (!hasCode && !hasHeredoc && pipedInto && mode === 'auto') result.raise('outside', REASONS.system)
    // Inline code that names a remote URL probably fetches it.
    if (args.some((a) => !URL_PATTERN.test(a.value) && mentionsRemoteUrl(a.value)))
      result.raise('outside', REASONS.network)
  }
  if (DATA_PROGRAMS.has(name)) {
    // `echo`, `printf`: the words are only printed; a redirect target was checked above.
    for (const word of args) checkPathWord(word, ctx, mode, result, { data: true })
    return
  }
  if (PATTERN_PROGRAMS.has(name)) {
    // `grep -rn "/api/tasks" src`: the first operand (or `-e`'s value) is a pattern, not a file.
    let patternSeen = args.some((a) => a.value === '-e' || a.value === '-f' || a.value.startsWith('--regexp'))
    for (let k = 0; k < args.length; k += 1) {
      const word = args[k] as Word
      if (word.value === '-e' || word.value === '--regexp') {
        const pattern = args[k + 1]
        if (pattern) checkPathWord(pattern, ctx, mode, result, { data: true })
        k += 1
        continue
      }
      if (word.value.startsWith('-')) {
        // `awk -F/`, `sed -i.bak`: flags of pattern tools are not paths, only secrets matter.
        checkPathWord(word, ctx, mode, result, { data: true })
        continue
      }
      checkPathWord(word, ctx, mode, result, patternSeen ? {} : { data: true })
      patternSeen = true
    }
    return
  }
  for (const word of args) checkPathWord(word, ctx, mode, result)
}

const DATA_PROGRAMS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  ':',
  'test',
  '[',
  'expr',
  'sleep',
  'date',
  'pwd',
  'which',
])
const PATTERN_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'jq'])

function analyzeWrapped(
  args: Word[],
  hasHeredoc: boolean,
  pipedInto: boolean,
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
) {
  let k = 0
  while (k < args.length && (args[k] as Word).value.startsWith('-')) k += 1
  const inner = args.slice(k)
  if (inner.length) analyzeProgram(inner, hasHeredoc, pipedInto, ctx, mode, result)
}

function analyzeShellInvocation(
  args: Word[],
  hasHeredoc: boolean,
  pipedInto: boolean,
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
) {
  let k = 0
  let inline = false
  while (k < args.length) {
    const value = (args[k] as Word).value
    if (value === '-o' || value === '+o') {
      k += 2
      continue
    }
    if (/^[-+][A-Za-z]+$/.test(value)) {
      if (value.startsWith('-') && value.includes('c')) inline = true
      k += 1
      continue
    }
    if (value === '--') {
      k += 1
    }
    break
  }
  const script = args[k]
  if (inline) {
    if (!script) return result.raise('outside', REASONS.unparseable)
    if (script.expands) {
      scanWord(script, ctx, result)
      if (mode === 'auto') result.raise('outside', REASONS.expansion)
      return
    }
    // `bash -lc '<cmd>'`: judge the inner command as if it were typed directly.
    analyzeNested(script.value, ctx, mode, result)
    return
  }
  if (script) {
    // `bash scripts/build.sh`: a script in the worktree is the project's own, like `pnpm test`.
    for (const word of args.slice(k)) checkPathWord(word, ctx, mode, result)
    return
  }
  if (!hasHeredoc && pipedInto && mode === 'auto') result.raise('outside', REASONS.system)
}

function changeDirectory(args: Word[], ctx: Context, mode: 'auto' | 'full', result: Verdict) {
  const target = args.find((a) => !/^-[LPe@]+$/.test(a.value))
  if (!target) {
    if (args.length === 0) return enter([ctx.env.home], ctx, mode, result)
    return
  }
  if (target.value === '-') {
    if (mode === 'auto') result.raise('outside', REASONS.cd)
    ctx.unknownCwd = true
    return
  }
  const resolved = resolveWord(target.value, ctx, target.expands)
  if (resolved.kind !== 'paths') {
    if (mode === 'auto')
      result.raise('outside', resolved.kind === 'expansion' ? REASONS.expansion : REASONS.cd)
    ctx.unknownCwd = true
    return
  }
  for (const p of resolved.paths) checkResolvedPath(p, ctx, mode, result, REASONS.cd)
  enter(resolved.paths, ctx, mode, result)
}

function enter(paths: string[], ctx: Context, mode: 'auto' | 'full', result: Verdict) {
  if (ctx.cdReplaces && paths.length) ctx.cwds = new Set()
  for (const p of paths) {
    if (!isInsideAllowed(p, ctx)) {
      checkResolvedPath(p, ctx, mode, result, REASONS.cd)
      if (mode === 'auto') result.raise('outside', REASONS.cd)
    }
    ctx.cwds.add(p)
  }
}

const GIT_REMOTE_COMMANDS = new Set([
  'push',
  'fetch',
  'pull',
  'clone',
  'ls-remote',
  'submodule',
  'send-email',
  'request-pull',
  'daemon',
  'archive',
  'lfs',
  'svn',
  'p4',
  'remote',
])
const GIT_OUTSIDE_COMMANDS = new Set([
  'config',
  'worktree',
  'filter-branch',
  'replace',
  'gc',
  'prune',
  'update-server-info',
])

function analyzeGit(args: Word[], ctx: Context, mode: 'auto' | 'full', result: Verdict) {
  let k = 0
  while (k < args.length) {
    const value = (args[k] as Word).value
    if (value === '-C') {
      const dir = args[k + 1]
      if (!dir) return result.raise('outside', REASONS.unparseable)
      checkPathWord(dir, ctx, mode, result, { directory: true })
      k += 2
      continue
    }
    if (value === '-c' || value.startsWith('--config-env') || value.startsWith('--exec-path')) {
      // `-c core.sshCommand=…`, `-c core.pager=…`: per-command config can run any program.
      if (mode === 'auto') result.raise('outside', REASONS.git)
      k += value === '-c' ? 2 : 1
      continue
    }
    if (value.startsWith('--git-dir') || value.startsWith('--work-tree') || value.startsWith('--namespace')) {
      const inline = value.includes('=')
      const dir = inline ? { ...(args[k] as Word), value: value.slice(value.indexOf('=') + 1) } : args[k + 1]
      if (dir) checkPathWord(dir, ctx, mode, result, { directory: true })
      k += inline ? 1 : 2
      continue
    }
    if (value.startsWith('-')) {
      k += 1
      continue
    }
    break
  }
  const sub = args[k]?.value
  const subArgs = args.slice(k + 1)
  if (sub === 'credential' || sub?.startsWith('credential-')) return result.raise('forbidden', REASONS.secret)
  if (sub === 'remote') {
    // `git remote` and `git remote -v` only list; everything else changes or contacts a remote.
    if (subArgs.every((a) => a.value === '-v' || a.value === '--verbose')) return
  }
  if (sub && GIT_REMOTE_COMMANDS.has(sub)) {
    if (sub === 'archive' && !subArgs.some((a) => a.value.startsWith('--remote'))) {
      // A local archive is just a file write.
    } else return result.raise('outside', REASONS.git)
  }
  if (sub && GIT_OUTSIDE_COMMANDS.has(sub)) {
    // Worktrees share the main checkout's .git: config and worktree changes land outside this worktree.
    if (!(sub === 'config' && subArgs.some((a) => ['--get', '--list', '-l', '--get-all'].includes(a.value))))
      result.raise('outside', REASONS.git)
  }
  if (sub === 'branch' && subArgs.some((a) => /^-(?:d|D)$|^--delete$|^-[a-zA-Z]*[dD]$/.test(a.value)))
    result.raise('outside', REASONS.git)
  for (let k = 0; k < subArgs.length; k += 1) {
    const word = subArgs[k] as Word
    if (/^-[a-zA-Z]*m$|^--message$/.test(word.value) && subArgs[k + 1]) {
      // `git commit -m "$(cat <<'EOF' … EOF)"`: the message is text.
      checkPathWord(subArgs[k + 1] as Word, ctx, mode, result, { data: true })
      k += 1
      continue
    }
    if (word.value.startsWith('--message=')) {
      checkPathWord(word, ctx, mode, result, { data: true })
      continue
    }
    checkPathWord(word, ctx, mode, result, { substitution: true })
  }
}

/** Subcommands that install exactly what the lockfile says (or run project scripts): fine inside the worktree. */
const INSTALL_COMMANDS = new Set(['install', 'i', 'ci', 'clean-install', 'install-clean', 'isntall'])
const PM_OUTSIDE = new Set([
  'add',
  'publish',
  'unpublish',
  'login',
  'logout',
  'adduser',
  'add-user',
  'deprecate',
  'dist-tag',
  'owner',
  'access',
  'team',
  'org',
  'token',
  'whoami',
  'profile',
  'star',
  'stars',
  'dlx',
  'create',
  'init',
  'update',
  'up',
  'upgrade',
  'upgrade-interactive',
  'outdated',
  'audit',
  'view',
  'info',
  'show',
  'search',
  'link',
  'unlink',
  'config',
  'set',
  'store',
  'cache',
  'env',
  'setup',
  'self-update',
  'patch-commit',
  'bugs',
  'docs',
  'repo',
  'home',
  'fund',
  'doctor',
  'x',
  'npm',
  'plugin',
  'global',
])
const PM_SECRET = new Set(['login', 'logout', 'adduser', 'add-user', 'token'])

function analyzePackageManager(
  name: string,
  args: Word[],
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
) {
  if (
    args.some(
      (a) =>
        a.value === '-g' ||
        a.value === '--global' ||
        a.value.startsWith('--location=g') ||
        a.value.startsWith('--prefix') ||
        a.value.startsWith('--userconfig') ||
        a.value.startsWith('--globalconfig') ||
        a.value.startsWith('--registry'),
    )
  )
    return result.raise('outside', REASONS.packages)
  const positional = args.filter((a) => !a.value.startsWith('-'))
  // `pnpm --filter web test`: skip the flag's value.
  const flagTakesValue = new Set(['--filter', '-F', '--dir', '-C', '--workspace', '-w', '--cwd', '--prefix'])
  let sub: string | undefined
  const rest: Word[] = []
  for (let k = 0; k < args.length; k += 1) {
    const value = (args[k] as Word).value
    if (flagTakesValue.has(value)) {
      if (['--dir', '-C', '--cwd'].includes(value) && args[k + 1])
        checkPathWord(args[k + 1] as Word, ctx, mode, result, { directory: true })
      k += 1
      continue
    }
    if (/^--(?:dir|cwd)=/.test(value)) {
      checkPathWord({ ...(args[k] as Word), value: value.slice(value.indexOf('=') + 1) }, ctx, mode, result, {
        directory: true,
      })
      continue
    }
    if (value.startsWith('-')) continue
    if (sub === undefined) sub = value
    else rest.push(args[k] as Word)
  }
  void positional
  if (sub === undefined) {
    // `yarn` alone installs from the lockfile; `pnpm`/`npm` alone print help.
    return
  }
  if (PM_SECRET.has(sub)) return result.raise('forbidden', REASONS.secret)
  if (INSTALL_COMMANDS.has(sub)) {
    // `npm install` installs the lockfile; `npm install left-pad` adds a new package from the registry.
    if (rest.length) result.raise('outside', REASONS.packages)
    return
  }
  if (sub === 'exec' || sub === 'run' || sub === 'run-script' || sub === 'test' || sub === 't') {
    for (const word of rest) checkPathWord(word, ctx, mode, result)
    return
  }
  if (PM_OUTSIDE.has(sub)) return result.raise('outside', REASONS.packages)
  // Anything else is a project script (`pnpm check`, `yarn build`) or a local command (`pnpm why`).
  for (const word of rest) checkPathWord(word, ctx, mode, result)
  void name
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

type Resolved = { kind: 'paths'; paths: string[] } | { kind: 'expansion' } | { kind: 'unknown-home' }

/** Resolves a path-like word against every possible working directory. */
function resolveWord(value: string, ctx: Context, expands = false): Resolved {
  if (expands) return { kind: 'expansion' }
  const { path } = ctx
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))
    return { kind: 'paths', paths: [path.resolve(ctx.env.home, value.slice(2) || '.')] }
  if (value.startsWith('~')) return { kind: 'unknown-home' }
  // `/dev/null` and friends keep their POSIX spelling even when paths follow Windows rules (Git Bash has them).
  if (DEVICES.has(value)) return { kind: 'paths', paths: [value] }
  const windowsAbsolute = /^[A-Za-z]:[\\/]|^\\\\/.test(value)
  if (windowsAbsolute && path === posix) return { kind: 'paths', paths: [`//windows/${value}`] }
  if (path === win32) {
    // Git Bash (`/c/Users/…`), Cygwin (`/cygdrive/c/…`) and WSL (`/mnt/c/…`) spellings of a drive path.
    const drive = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?:[\\/](.*))?$/.exec(value)
    if (drive?.[1]) return { kind: 'paths', paths: [win32.resolve(`${drive[1]}:\\`, drive[2] ?? '')] }
  }
  if (path.isAbsolute(value)) return { kind: 'paths', paths: [path.resolve(value)] }
  if (ctx.unknownCwd) return { kind: 'expansion' }
  return { kind: 'paths', paths: [...ctx.cwds].map((cwd) => path.resolve(cwd, value)) }
}

function isInsideAllowed(target: string, ctx: Context): boolean {
  if (DEVICES.has(target) || /^(?:nul|con)$/i.test(ctx.path.basename(target))) return true
  if (within(ctx.path, ctx.worktree, target)) return true
  return ctx.env.tempDirs.some((dir) => within(ctx.path, dir, target))
}

/**
 * A Windows 8.3 short name (`JOYDAT~1`, `CLAUDE~1`) outside the worktree and the temp dirs. Joy cannot tell which
 * long name it stands for without the file system, so it could be JOY_HOME or `.claude`: treated as a secret.
 */
function shortNameOutside(target: string, ctx: Context): boolean {
  if (ctx.path !== win32) return false
  if (within(ctx.path, ctx.worktree, target)) return false
  if (ctx.env.tempDirs.some((dir) => within(ctx.path, dir, target))) return false
  return target.split(/[\\/]/).some((segment) => /~\d+$/.test(segment.replace(/\.[^.]*$/, '')))
}

function isSecretPath(target: string, ctx: Context): boolean {
  const { path } = ctx
  if (within(path, ctx.worktree, target)) return false
  if (joyHomes(ctx.env).some((dir) => within(path, dir, target))) return true
  if (shortNameOutside(target, ctx)) return true
  const home = path.resolve(ctx.env.home)
  if (within(path, home, target)) {
    const rel = path.relative(home, target).replace(/\\/g, '/')
    if (SECRET_HOME_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))) return true
  }
  const normalized = target.replace(/\\/g, '/')
  if (SYSTEM_SECRET_PATHS.some((p) => normalized === p || normalized.startsWith(`${p}/`))) return true
  return normalized.split('/').some((segment) => SECRET_SEGMENTS.has(segment))
}

function checkResolvedPath(
  target: string,
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
  reason: string,
) {
  if (isSecretPath(target, ctx)) return result.raise('forbidden', REASONS.secret)
  if (!isInsideAllowed(target, ctx) && mode === 'auto') result.raise('outside', reason)
}

const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
/** `git@github.com:org/repo.git`, `user@host:path` (scp-style remotes). */
const SCP_PATTERN = /^[\w.-]+@[\w.-]+:/

interface PathCheck {
  /** The word is the target of `>`, `<`: always a file name, even without a `/`. */
  redirect?: boolean
  /** The word is a directory a program switches to (`git -C`, `pnpm --dir`). */
  directory?: boolean
  /**
   * A command substitution in the word is fine once the substituted command itself was checked (`git checkout
   * $(git rev-parse HEAD~1)`). Named variables still count as unknown.
   */
  substitution?: boolean
  /**
   * The program treats the word as data, not as a file (`echo`, `git commit -m`, a grep pattern): only secrets in it
   * matter. Implies `substitution`.
   */
  data?: boolean
}

/**
 * Checks an argument that may be a path. Plain words (`src`, `--watch`, `HEAD~1`) resolve inside the working
 * directory, which is inside the worktree, so only words that can point elsewhere matter.
 */
function checkPathWord(
  word: Word,
  ctx: Context,
  mode: 'auto' | 'full',
  result: Verdict,
  check: PathCheck = {},
) {
  scanWord(word, ctx, result)
  if (word.expands) {
    if ((check.data || check.substitution) && !word.variables) return
    if (mode === 'auto') result.raise('outside', REASONS.expansion)
    return
  }
  if (check.data) return
  let value = word.value
  if (URL_PATTERN.test(value)) {
    if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, '')
    else return result.raise('outside', REASONS.network)
  }
  if (SCP_PATTERN.test(value) && !check.data) return result.raise('outside', REASONS.network)
  // `--out=/x`, `of=/dev/sda`: the value after `=` is the path.
  const candidates = [value]
  const eq = value.indexOf('=')
  if (eq > 0 && !check.redirect) candidates.push(value.slice(eq + 1))
  // `-I/usr/include`, `-o/tmp/x`: short flags glued to a path.
  const glued = /^-[A-Za-z]([~/\\.].*)$/.exec(value)
  if (glued?.[1]) candidates.push(glued[1])
  for (const candidate of candidates) {
    if (candidate === '' || (!check.redirect && !check.directory && !looksLikePath(candidate))) continue
    // Free text with spaces (`-m "fix a/b"`) is not a file name; paths inside it are found by scanText.
    if (!check.redirect && /\s/.test(candidate)) continue
    const resolved = resolveWord(candidate, ctx)
    if (resolved.kind !== 'paths') {
      if (mode === 'auto')
        result.raise('outside', resolved.kind === 'expansion' ? REASONS.cd : REASONS.outsidePath)
      continue
    }
    for (const p of resolved.paths) checkResolvedPath(p, ctx, mode, result, REASONS.outsidePath)
  }
  if (mode === 'auto' && !check.data) scanEmbedded(word.value, ctx, result)
}

function looksLikePath(value: string): boolean {
  return (
    /[\\/]/.test(value) ||
    value.startsWith('~') ||
    value === '..' ||
    value === '.' ||
    /^[A-Za-z]:/.test(value)
  )
}

function checkAssignment(word: Word, ctx: Context, mode: 'auto' | 'full', result: Verdict) {
  const value = word.value.slice(word.value.indexOf('=') + 1)
  // PATH-like values list several paths.
  for (const part of value.split(ctx.path === win32 ? ';' : ':')) {
    if (part === '') continue
    checkPathWord({ ...word, value: part }, ctx, mode, result)
  }
}

/**
 * Secrets anywhere in a word, including text that is not itself a path (`node -e "…/.ssh/id_rsa…"`,
 * `cat $HOME/.joy/config.yaml`, a variable named like a token). Applies in every mode.
 */
function scanWord(word: Word, ctx: Context, result: Verdict) {
  scanSecrets(word.value, ctx, result, word.expands)
  if (word.expands) {
    for (const match of word.value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (SECRET_VARIABLE.test(match[1] as string)) result.raise('forbidden', REASONS.secret)
    }
  }
}

/** Here-doc bodies and here-strings: data, but a secret path in them is still forbidden and an outside path asks. */
function scanText(text: string, ctx: Context, mode: 'auto' | 'full', result: Verdict) {
  scanSecrets(text, ctx, result)
  if (mode === 'auto') scanEmbedded(text, ctx, result)
}

const HOME_PREFIX =
  /(?:^|[\s'"=(,:])(?:~|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE|[A-Za-z]:[\\/]Users[\\/][^\\/\s'"]+|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+|\/root)[\\/]/i

function scanSecrets(text: string, ctx: Context, result: Verdict, expands = false) {
  const normalized = text.replace(/\\/g, '/')
  // Short names inside free text (inline code) too, in every mode.
  if (ctx.path === win32) {
    for (const candidate of embeddedPaths(text)) {
      const resolved = resolveWord(candidate, ctx)
      if (resolved.kind === 'paths' && resolved.paths.some((p) => shortNameOutside(p, ctx)))
        return result.raise('forbidden', REASONS.secret)
    }
  }
  const inWorktree = () => {
    if (expands) return false
    const candidates = [...embeddedPaths(text), ...(looksLikePath(text) && !/\s/.test(text) ? [text] : [])]
    return (
      candidates.length > 0 &&
      candidates.every((c) => {
        const r = resolveWord(c, ctx)
        return r.kind === 'paths' && r.paths.every((p) => within(ctx.path, ctx.worktree, p))
      })
    )
  }
  // Worktrees live in JOY_HOME by default: the task's own worktree is fine, anything else there is Joy's data.
  // On Windows the comparison ignores case, and the Git Bash / WSL spellings of the drive count too.
  const windows = ctx.path === win32
  const haystack = windows ? normalized.toLowerCase() : normalized
  for (const dir of joyHomes(ctx.env)) {
    const joy = dir.replace(/\\/g, '/').replace(/\/+$/, '')
    const spellings = [joy]
    const drive = /^([A-Za-z]):(\/.*)$/.exec(joy)
    if (drive?.[1] && drive[2]) {
      const letter = drive[1].toLowerCase()
      spellings.push(`/${letter}${drive[2]}`, `/mnt/${letter}${drive[2]}`, `/cygdrive/${letter}${drive[2]}`)
    }
    if (
      spellings.some((spelling) => haystack.includes(windows ? spelling.toLowerCase() : spelling)) &&
      !inWorktree()
    )
      return result.raise('forbidden', REASONS.secret)
  }
  for (const name of SECRET_HOME_PATHS) {
    const escaped = name.replace(/[.]/g, '\\.')
    if (!new RegExp(`(?:^|[/\\s'"=(,:])${escaped}(?:$|[/\\s'"),;:])`).test(normalized)) continue
    // `.claude`, `.codex`, `.npmrc`, `.docker` are also common project folders: a problem only next to a home path.
    const strong = SECRET_SEGMENTS.has(name.split('/')[0] as string)
    if (
      !strong &&
      !HOME_PREFIX.test(text) &&
      !ctx.unknownCwd &&
      ![...ctx.cwds].some((c) => !within(ctx.path, ctx.worktree, c))
    )
      continue
    if (inWorktree()) continue
    return result.raise('forbidden', REASONS.secret)
  }
}

/** Paths inside free text (inline code, a here-doc): anything after a delimiter starting with `/`, `~/`, `../`, `C:\`. */
function scanEmbedded(text: string, ctx: Context, result: Verdict) {
  for (const candidate of embeddedPaths(text)) {
    if (candidate === text) continue
    const resolved = resolveWord(candidate, ctx)
    if (resolved.kind !== 'paths') {
      result.raise('outside', REASONS.outsidePath)
      continue
    }
    for (const p of resolved.paths) checkResolvedPath(p, ctx, 'auto', result, REASONS.outsidePath)
  }
}

function embeddedPaths(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(
    /(?:^|[\s'"=(,:;`])((?:~(?=[/\\])|\.\.(?=[/\\])|[A-Za-z]:[\\/]|\/(?=[A-Za-z0-9._~-]))[^\s'"(),;`]*)/g,
  )) {
    const candidate = match[1] as string
    found.push(candidate)
  }
  return found
}

/** A URL in inline code (`node -e "fetch('https://…')"`): the code probably fetches it. */
function mentionsRemoteUrl(text: string): boolean {
  return /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?!localhost[:/]|127\.0\.0\.1[:/]|\[::1\][:/])/.test(text)
}
