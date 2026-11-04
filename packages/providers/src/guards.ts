// Tiny helpers for reading untrusted JSON from CLIs without `any`.

export type Rec = Record<string, unknown>

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function rec(v: unknown): Rec | undefined {
  return isRecord(v) ? v : undefined
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** `{ key: value }` when value is defined, `{}` otherwise. Keeps optional properties absent. */
export function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
