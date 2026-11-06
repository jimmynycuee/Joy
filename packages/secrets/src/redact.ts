const MIN_LENGTH = 8
export const REDACTED = '[REDACTED]'

/** Well-known token shapes, scrubbed even if Joy never saw the value (e.g. an agent printed one). */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot tokens
  // Whole PEM private key blocks; a BEGIN line without its END is still redacted from there on.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g, // Stripe live keys
  /\bglpat-[0-9A-Za-z_-]{20,}\b/g, // GitLab personal access tokens
]

/**
 * Removes secrets from anything about to be logged, stored as an event, or shown in the UI.
 * Register every secret value Joy reads (SecretStore's onSecret does this).
 */
export class Redactor {
  private readonly known = new Set<string>()

  add(value: string): void {
    if (value.length >= MIN_LENGTH) this.known.add(value)
  }

  redact(text: string): string {
    let out = text
    // Longest first, so a secret that contains another is fully removed.
    for (const value of [...this.known].sort((a, b) => b.length - a.length))
      out = out.split(value).join(REDACTED)
    for (const re of PATTERNS) out = out.replace(re, REDACTED)
    return out
  }

  /** Deep copy with every string value redacted. Keys are left alone. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T
    if (Array.isArray(value)) return value.map((v: unknown) => this.redactValue(v)) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.redactValue(v as unknown)]),
      ) as T
    }
    return value
  }
}
