import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { JoyConfig } from '@joy/config'
import { downloadFile, errorMessage, removeWithConfirmation, request, saveApiToken } from '../api.js'
import { DOCTOR_LABELS, doctorStatusLabel, formatBytes } from '../labels.js'
import type { DoctorReport, SecretStatus } from '../types.js'
import { Button } from './ui.js'

/** Telegram settings: owner chat id (config) and bot token (OS keychain). Applies after Joy restarts. */
export function TelegramSettings({
  config,
  onConfig,
}: {
  config: JoyConfig
  onConfig: (config: JoyConfig) => void
}) {
  const [tokenStatus, setTokenStatus] = useState<SecretStatus | null>(null)
  const [message, setMessage] = useState('')
  // An older server may not send the channels section at all.
  const chatId = config.channels?.telegram?.owner_chat_id

  useEffect(() => {
    request<SecretStatus>('/api/secrets/telegram-bot-token')
      .then(setTokenStatus)
      .catch(() => setTokenStatus(null))
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // currentTarget is cleared once the handler awaits, so keep the element.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const chatId = String(form.get('telegram-chat-id') ?? '').trim()
    const token = String(form.get('telegram-token') ?? '').trim()
    setMessage('')
    try {
      const next = { ...config, channels: { telegram: chatId ? { owner_chat_id: chatId } : {} } }
      const saved = await request<{ config: JoyConfig }>('/api/config', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      onConfig(saved.config)
      if (token) {
        setTokenStatus(
          await request<SecretStatus>('/api/secrets/telegram-bot-token', {
            method: 'PUT',
            body: JSON.stringify({ value: token }),
          }),
        )
      }
      formElement.reset()
      setMessage('已儲存。重新啟動 Joy 後才會連上 Telegram。')
    } catch (error) {
      setMessage(errorMessage(error, '無法儲存 Telegram 設定'))
    }
  }

  return (
    <section className="card settings-card" aria-labelledby="telegram-heading">
      <div className="section-heading">
        <h2 id="telegram-heading">Telegram</h2>
        <span className={tokenStatus?.set && chatId ? 'status-pill configured' : 'status-pill'}>
          {tokenStatus?.set && chatId ? '已設定' : '未設定'}
        </span>
      </div>
      <p className="muted">
        Joy 會把需要你同意的動作和任務結果傳到你的 Telegram 對話，也只接受從這個對話按下的按鈕。用 @BotFather
        建立機器人；token 會存在作業系統鑰匙圈。
      </p>
      <form className="field-stack" onSubmit={(event) => void save(event)}>
        <label htmlFor="telegram-chat-id">你的 chat id</label>
        <input
          id="telegram-chat-id"
          name="telegram-chat-id"
          inputMode="numeric"
          pattern="-?[0-9]+"
          defaultValue={chatId ?? ''}
        />
        {tokenStatus?.source === 'env' ? (
          <div className="env-managed" role="status">
            由環境變數 JOY_TELEGRAM_BOT_TOKEN 管理。
          </div>
        ) : (
          <>
            <label htmlFor="telegram-token">{tokenStatus?.set ? '換一個機器人 token' : '機器人 token'}</label>
            <input id="telegram-token" name="telegram-token" type="password" autoComplete="new-password" />
          </>
        )}
        <div className="button-row">
          <Button variant="primary" type="submit">
            儲存 Telegram 設定
          </Button>
        </div>
        {message ? (
          <p className="muted" role="status">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  )
}

type WorktreeRow = {
  path: string
  repoPath: string
  branch: string | null
  diskUsageBytes: number
  unpushedCommitCount: number
  ageDays: number
  stale: boolean
  active: boolean
  taskId?: string
  taskTitle?: string
  taskStatus?: string
}

/** Worktree cleanup (T2.8): disk usage, idle worktrees, and removal that never loses commits silently. */
export function WorktreesPanel() {
  const [data, setData] = useState<{
    worktrees: WorktreeRow[]
    totalBytes: number
    staleAfterDays: number
  } | null>(null)
  const [failure, setFailure] = useState('')

  async function load() {
    const body = await request<{ worktrees?: WorktreeRow[]; totalBytes?: number; staleAfterDays?: number }>(
      '/api/worktrees',
    )
    setData({
      worktrees: Array.isArray(body.worktrees) ? body.worktrees : [],
      totalBytes: typeof body.totalBytes === 'number' ? body.totalBytes : 0,
      staleAfterDays: typeof body.staleAfterDays === 'number' ? body.staleAfterDays : 14,
    })
  }

  useEffect(() => {
    void load().catch(() => undefined)
  }, [])

  async function remove(row: WorktreeRow) {
    setFailure('')
    try {
      await removeWithConfirmation('/api/worktrees/remove', { path: row.path })
    } catch (error) {
      setFailure(errorMessage(error, '無法移除工作副本'))
    }
    await load().catch(() => undefined)
  }

  const stale = data?.worktrees.filter((row) => row.stale && !row.active) ?? []
  return (
    <section className="card settings-card" aria-label="工作副本" data-testid="worktrees-panel">
      <h2>工作副本（worktree）</h2>
      <p className="muted">
        {data ? `共 ${data.worktrees.length} 個，佔用 ${formatBytes(data.totalBytes)}。` : '載入中…'}
        {stale.length ? `其中 ${stale.length} 個閒置超過 ${data?.staleAfterDays} 天。` : ''}
      </p>
      {data?.worktrees.length ? (
        <ul className="row-list">
          {data.worktrees.map((row) => (
            <li key={row.path} className={row.stale ? 'row-item stale' : 'row-item'}>
              <span className="row-copy">
                <strong>{row.taskTitle ?? row.branch ?? row.path}</strong>
                <span className="muted">
                  {' '}
                  · {formatBytes(row.diskUsageBytes)} · 閒置 {Math.floor(row.ageDays)} 天
                  {row.unpushedCommitCount ? ` · ${row.unpushedCommitCount} 個 commit 還沒推送` : ''}
                  {row.stale ? ' · 閒置' : ''}
                </span>
              </span>
              {row.active ? (
                <span className="muted">執行中</span>
              ) : (
                <Button variant="danger" onClick={() => void remove(row)}>
                  移除
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {failure ? <p className="form-error">{failure}</p> : null}
    </section>
  )
}

/** Debug logs (T4.8): the last 14 days, secrets already removed, for attaching to a bug report. */
export function LogsPanel() {
  const [logs, setLogs] = useState<Array<{ day: string; name: string; bytes: number }>>([])
  const [failure, setFailure] = useState('')

  useEffect(() => {
    request<{ logs?: Array<{ day: string; name: string; bytes: number }> }>('/api/logs')
      .then((body) => setLogs(Array.isArray(body.logs) ? body.logs : []))
      .catch(() => undefined)
  }, [])

  return (
    <section className="card settings-card" aria-label="除錯紀錄" data-testid="logs-panel">
      <h2>除錯紀錄</h2>
      <p className="muted">每天一個檔案，保留 14 天。寫入前會先移除已知的密碼和金鑰。</p>
      <ul className="row-list">
        {logs.map((log) => (
          <li key={log.day} className="row-item">
            <span className="row-copy">
              {log.day} <span className="muted">· {formatBytes(log.bytes)}</span>
            </span>
            <Button
              onClick={() =>
                void downloadFile(`/api/logs/${log.day}`, log.name).catch((error: unknown) =>
                  setFailure(errorMessage(error, '下載失敗')),
                )
              }
            >
              下載
            </Button>
          </li>
        ))}
      </ul>
      {logs.length === 0 ? <p className="muted">還沒有紀錄。</p> : null}
      {failure ? <p className="form-error">{failure}</p> : null}
    </section>
  )
}

/** Backups and export (T4.7). Restoring replaces the database, so it is a command run while Joy is stopped. */
export function BackupsPanel() {
  const [backups, setBackups] = useState<Array<{ day: string; bytes: number }>>([])
  const [message, setMessage] = useState('')

  async function load() {
    const body = await request<{ backups?: Array<{ day: string; bytes: number }> }>('/api/backups')
    setBackups(Array.isArray(body.backups) ? body.backups : [])
  }

  useEffect(() => {
    void load().catch(() => undefined)
  }, [])

  async function backupNow() {
    try {
      const body = await request<{ created?: string | null }>('/api/backups', { method: 'POST', body: '{}' })
      setMessage(body.created ? '已備份。' : '今天已經備份過了。')
      await load()
    } catch (error) {
      setMessage(errorMessage(error, '備份失敗'))
    }
  }

  async function exportJson() {
    try {
      await downloadFile('/api/export', `joy-export-${new Date().toISOString().slice(0, 10)}.json`)
    } catch (error) {
      setMessage(errorMessage(error, '匯出失敗'))
    }
  }

  return (
    <section className="card settings-card" aria-label="備份" data-testid="backups-panel">
      <h2>備份與匯出</h2>
      <p className="muted">Joy 每天備份一次資料庫，保留最近 7 份。</p>
      <ul className="row-list">
        {backups.map((backup) => (
          <li key={backup.day} className="row-item">
            <span className="row-copy">
              {backup.day} <span className="muted">· {formatBytes(backup.bytes)}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <Button onClick={() => void backupNow()}>立即備份</Button>
        <Button onClick={() => void exportJson()}>匯出任務和記憶（JSON）</Button>
      </div>
      <p className="muted">
        還原方式：先停止 Joy，再執行 <code>pnpm joy restore 2026-11-06</code>（日期換成清單裡的一天）。
      </p>
      {message ? <p className="muted">{message}</p> : null}
    </section>
  )
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** Why this browser cannot receive notifications, or undefined when it can. */
function pushUnsupportedReason(): string | undefined {
  if (!window.isSecureContext)
    return '通知需要 HTTPS（或 localhost）。手機上請透過 `tailscale serve` 開 Joy（見 README）。'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return '這個瀏覽器不支援 Web Push。iPhone 請先把 Joy 加到主畫面。'
  return undefined
}

/** Turns on notifications for this device (T4.2): task results and approval requests. */
export function NotificationsPanel() {
  const [state, setState] = useState<'off' | 'on' | 'busy'>('off')
  const [message, setMessage] = useState('')
  const unsupported = pushUnsupportedReason()

  useEffect(() => {
    if (unsupported) return
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? 'on' : 'off'))
      .catch(() => undefined)
  }, [unsupported])

  async function enable() {
    setState('busy')
    setMessage('')
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('沒有允許通知')
      const { publicKey } = await request<{ publicKey: string }>('/api/push/key')
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      })
      await request('/api/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      })
      setState('on')
    } catch (error) {
      setState('off')
      setMessage(errorMessage(error, '無法開啟通知'))
    }
  }

  async function disable() {
    setState('busy')
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await request('/api/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined)
      await subscription.unsubscribe()
    }
    setState('off')
  }

  return (
    <section className="card settings-card" aria-label="通知" data-testid="notifications-panel">
      <h2>這台裝置的通知</h2>
      <p className="muted">任務完成或需要你同意時，這台裝置會收到通知。</p>
      {unsupported ? (
        <p className="muted">{unsupported}</p>
      ) : state === 'on' ? (
        <div className="button-row">
          <span>這台裝置已開啟通知。</span>
          <Button onClick={() => void request('/api/push/test', { method: 'POST', body: '{}' })}>
            傳送測試通知
          </Button>
          <Button onClick={() => void disable()}>關閉</Button>
        </div>
      ) : (
        <div className="button-row">
          <Button disabled={state === 'busy'} onClick={() => void enable()}>
            開啟通知
          </Button>
        </div>
      )}
      {message ? <p className="form-error">{message}</p> : null}
    </section>
  )
}

/** Regenerating the token logs out every other device and browser tab (T4.1). */
export function AccessTokenPanel() {
  const [shown, setShown] = useState('')
  const [failure, setFailure] = useState('')

  async function regenerate() {
    if (!window.confirm('要重新產生存取權杖嗎？其他裝置和分頁都要改用新的權杖。')) return
    setFailure('')
    try {
      const body = await request<{ token: string }>('/api/token/rotate', { method: 'POST', body: '{}' })
      saveApiToken(body.token)
      setShown(body.token)
    } catch (error) {
      setFailure(errorMessage(error, '無法重新產生權杖'))
    }
  }

  return (
    <section className="card settings-card" aria-label="存取權杖" data-testid="access-token-panel">
      <h2>存取權杖</h2>
      <p className="muted">每個送到 Joy 的請求都要帶這個權杖。要從其他裝置連線（Tailscale）請看 README。</p>
      <div className="button-row">
        <Button onClick={() => void regenerate()}>重新產生權杖</Button>
      </div>
      {shown ? (
        <p>
          新權杖（只顯示這一次）：<code data-testid="new-token">{shown}</code>
        </p>
      ) : null}
      {failure ? <p className="form-error">{failure}</p> : null}
    </section>
  )
}

/** The environment check. Labels and summaries come from the server; only the status words are translated here. */
export function DoctorChecks({
  report,
  loading,
  onRetry,
}: {
  report: DoctorReport | null
  loading: boolean
  onRetry: () => void
}) {
  return (
    <section className="card settings-card" aria-labelledby="doctor-heading" data-testid="doctor-checks">
      <div className="section-heading">
        <h2 id="doctor-heading">環境檢查</h2>
        <Button aria-label="重新檢查環境" disabled={loading} onClick={onRetry}>
          重新檢查
        </Button>
      </div>
      {loading ? (
        <p className="muted" role="status">
          正在檢查 Joy 的環境…
        </p>
      ) : report ? (
        <ul className="doctor-check-list">
          {report.checks.map((check) => (
            <li className="doctor-check" key={check.id}>
              <div className="doctor-check-heading">
                <strong>{DOCTOR_LABELS[check.id] ?? check.label}</strong>
                <span className={`doctor-state doctor-state-${check.status}`}>
                  {doctorStatusLabel(check.status)}
                </span>
              </div>
              <p>{check.summary}</p>
              {check.repair !== 'No action needed.' && <p className="doctor-repair">{check.repair}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted" role="status">
          <p>目前無法取得環境檢查結果。</p>
          <Button onClick={onRetry}>再試一次</Button>
        </div>
      )}
    </section>
  )
}
