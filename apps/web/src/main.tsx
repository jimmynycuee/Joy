import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { UNAUTHORIZED_EVENT, apiToken, saveApiToken } from './api.js'
import { Mascot } from './components/Mascot.js'
import { Button } from './components/ui.js'
import { applyTheme, readTheme } from './theme.js'
import { Workspace } from './Workspace.js'

/** Shown when this device has no accepted access token (remote access, or after the token was regenerated). */
function TokenGate() {
  return (
    <main className="token-gate" data-testid="token-gate">
      <Mascot mood="normal" size={72} decorative />
      <h1>Joy 存取權杖</h1>
      <p className="muted">
        貼上 <code>~/.joy/api-token</code> 的內容：
      </p>
      <ul className="muted token-gate-steps">
        <li>
          Mac：Finder 按 ⌘⇧G，輸入 <code>~/.joy</code>，打開 api-token。
        </li>
        <li>
          Windows：檔案總管網址列輸入 <code>%USERPROFILE%\.joy</code>，打開 api-token。
        </li>
        <li>
          Linux：<code>cat ~/.joy/api-token</code>
        </li>
      </ul>
      <form
        className="field-stack"
        onSubmit={(event) => {
          event.preventDefault()
          const token = String(new FormData(event.currentTarget).get('token') ?? '').trim()
          if (!token) return
          saveApiToken(token)
          window.location.reload()
        }}
      >
        <input name="token" type="password" aria-label="存取權杖" autoComplete="off" required />
        <Button variant="primary" large type="submit">
          繼續
        </Button>
      </form>
    </main>
  )
}

function App() {
  const [unauthorized, setUnauthorized] = useState(() => !apiToken())
  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])
  return unauthorized ? <TokenGate /> : <Workspace />
}

export default App

// Apply the saved theme before the first paint so a dark preference does not flash light.
applyTheme(readTheme())

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing application root element')
// The service worker only shows notifications (T4.2); browsers allow it on HTTPS and localhost.
if ('serviceWorker' in navigator && window.isSecureContext)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)

createRoot(rootElement).render(<App />)
