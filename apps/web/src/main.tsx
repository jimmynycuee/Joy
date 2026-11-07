import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { UNAUTHORIZED_EVENT, apiToken, saveApiToken } from './api.js'
import { Button } from './components/ui.js'
import { applyTheme, readTheme } from './theme.js'
import { Workspace } from './Workspace.js'

/** Shown when this device has no accepted access token (remote access, or after the token was regenerated). */
function TokenGate() {
  return (
    <main className="token-gate" data-testid="token-gate">
      <h1>Joy 存取權杖</h1>
      <p className="muted">
        貼上執行 Joy 那台電腦裡 <code>~/.joy/api-token</code> 的內容。權杖只會存在這台裝置。
      </p>
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
