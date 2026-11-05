import { AsyncEntry } from '@napi-rs/keyring'
import { MIN_SECRET_VALUE_LENGTH } from './redact.js'

/** Every secret Joy knows about. Adding one here is the only way to store it. */
export const SECRET_NAMES = ['openai_api_key', 'telegram_bot_token', 'line_channel_secret'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

/** Environment variables that take precedence over the keychain, for CI and power users. */
const ENV_OVERRIDES: Partial<Record<SecretName, string>> = {
  openai_api_key: 'OPENAI_API_KEY',
  telegram_bot_token: 'JOY_TELEGRAM_BOT_TOKEN',
}

export interface SecretBackend {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<boolean>
}

interface KeychainEntry {
  getPassword(): Promise<string | null | undefined>
  setPassword(value: string): Promise<void>
  deletePassword(): Promise<boolean>
}

/** macOS Keychain, Windows Credential Manager, or the Secret Service on Linux. */
export class KeychainBackend implements SecretBackend {
  constructor(
    private readonly service = 'joy',
    private readonly entry: (service: string, name: string) => KeychainEntry = (s, n) => new AsyncEntry(s, n),
  ) {}

  async get(name: string): Promise<string | null> {
    return (await this.call(name, (e) => e.getPassword())) ?? null
  }
  async set(name: string, value: string): Promise<void> {
    await this.call(name, (e) => e.setPassword(value))
  }
  async delete(name: string): Promise<boolean> {
    return this.call(name, (e) => e.deletePassword())
  }

  private async call<T>(name: string, fn: (e: KeychainEntry) => Promise<T>): Promise<T> {
    try {
      return await fn(this.entry(this.service, name))
    } catch (err) {
      throw new Error(
        `Could not use the OS keychain for "${name}": ${(err as Error).message}. ` +
          'On macOS, allow Joy when the Keychain prompt appears. On Linux, run a Secret Service ' +
          '(GNOME Keyring or KWallet) and unlock it. Or set the value through its environment variable ' +
          '(OPENAI_API_KEY, JOY_TELEGRAM_BOT_TOKEN).',
        { cause: err },
      )
    }
  }
}

/** For tests only. */
export class MemoryBackend implements SecretBackend {
  readonly values = new Map<string, string>()
  async get(name: string) {
    return this.values.get(name) ?? null
  }
  async set(name: string, value: string) {
    this.values.set(name, value)
  }
  async delete(name: string) {
    return this.values.delete(name)
  }
}

export type SecretSource = 'env' | 'keychain'

export interface SecretStoreOptions {
  backend?: SecretBackend
  env?: NodeJS.ProcessEnv
  /** Every value read or written is registered here so it can be scrubbed from logs and events. */
  onSecret?: (value: string) => void
}

function assertRedactable(name: SecretName, value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH)
    throw new Error(
      `${name} must be at least ${MIN_SECRET_VALUE_LENGTH} characters long so Joy can redact it safely.`,
    )
}

export class SecretStore {
  private readonly backend: SecretBackend
  private readonly env: NodeJS.ProcessEnv
  private readonly onSecret: (value: string) => void

  constructor(options: SecretStoreOptions = {}) {
    this.backend = options.backend ?? new KeychainBackend()
    this.env = options.env ?? process.env
    this.onSecret = options.onSecret ?? (() => {})
  }

  async get(name: SecretName): Promise<string | null> {
    assertName(name)
    const envVar = ENV_OVERRIDES[name]
    const fromEnv = envVar ? this.env[envVar] : undefined
    const value = fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : await this.backend.get(name)
    if (value) {
      assertRedactable(name, value)
      this.onSecret(value)
    }
    return value
  }

  /** Where the value would come from, without revealing it. For the settings page. */
  async status(name: SecretName): Promise<{ set: boolean; source?: SecretSource }> {
    assertName(name)
    const envVar = ENV_OVERRIDES[name]
    const fromEnv = envVar ? this.env[envVar]?.trim() : undefined
    if (fromEnv) {
      assertRedactable(name, fromEnv)
      this.onSecret(fromEnv)
      return { set: true, source: 'env' }
    }
    const fromBackend = await this.backend.get(name)
    if (fromBackend) {
      assertRedactable(name, fromBackend)
      this.onSecret(fromBackend)
      return { set: true, source: 'keychain' }
    }
    return { set: false }
  }

  async set(name: SecretName, value: string): Promise<void> {
    assertName(name)
    const trimmed = value.trim()
    if (trimmed === '') throw new Error(`Refusing to store an empty ${name}. Use delete() to remove it.`)
    assertRedactable(name, trimmed)
    this.onSecret(trimmed)
    await this.backend.set(name, trimmed)
  }

  async delete(name: SecretName): Promise<boolean> {
    assertName(name)
    return this.backend.delete(name)
  }
}

function assertName(name: string): asserts name is SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown secret "${name}"`)
}
