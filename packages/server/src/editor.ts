import { spawn } from 'node:child_process'

/** Starts the owner's editor and resolves once it is running (it is not waited for). */
export type EditorRunner = (command: string, args: string[]) => Promise<void>

/** The configured editor command is not installed (or not on PATH). */
export class EditorNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`The editor command "${command}" was not found; set editor.command in ~/.joy/config.yaml`)
    this.name = 'EditorNotFoundError'
  }
}

/** The configured command and arguments, then the folder to open, always last. */
export function editorInvocation(
  editor: { command: string; args: readonly string[] },
  folder: string,
): { command: string; args: string[] } {
  return { command: editor.command, args: [...editor.args, folder] }
}

/**
 * Spawns without a shell, detached so the editor outlives Joy. On Windows the VS Code CLI is `code.cmd`, which needs
 * a shell; there the owner sets `editor.command` to the editor's .exe instead.
 */
export const spawnEditor: EditorRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? new EditorNotFoundError(command) : error),
    )
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
