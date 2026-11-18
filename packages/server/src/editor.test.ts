import { describe, expect, it } from 'vitest'
import { EditorNotFoundError, editorInvocation, spawnEditor } from './editor.js'

describe('editor', () => {
  it('puts the folder after the configured arguments', () => {
    expect(editorInvocation({ command: 'code', args: [] }, '/w/t1-a1')).toEqual({
      command: 'code',
      args: ['/w/t1-a1'],
    })
    expect(editorInvocation({ command: 'cursor', args: ['-n', '--reuse-window'] }, '/w/x')).toEqual({
      command: 'cursor',
      args: ['-n', '--reuse-window', '/w/x'],
    })
  })

  it('starts a command without a shell and reports a missing one', async () => {
    await expect(spawnEditor(process.execPath, ['-e', '0'])).resolves.toBeUndefined()
    const error = await spawnEditor('joy-no-such-editor-4711', ['/tmp']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EditorNotFoundError)
    expect((error as EditorNotFoundError).command).toBe('joy-no-such-editor-4711')
  })
})
