// The project check command is stored as argv and run without a shell, so the settings field is a plain line split on
// whitespace: no quoting, no pipes, no variables.

/** `pnpm check` → ['pnpm', 'check']. Empty text means "no check command" (null). */
export function parseCheckCommand(text: string): string[] | null {
  const argv = text.split(/\s+/).filter(Boolean)
  return argv.length > 0 ? argv : null
}

export function formatCheckCommand(argv: readonly string[] | undefined): string {
  return argv?.join(' ') ?? ''
}

/** Characters a shell would act on. They are passed to the program as-is here, which is almost never what was meant. */
export function shellCharactersIn(text: string): string | undefined {
  return /[|&;<>$`()"'\\*?~]/.exec(text)?.[0]
}
