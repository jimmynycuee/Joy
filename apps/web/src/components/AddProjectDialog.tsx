import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { errorMessage, request } from '../api.js'
import { folderErrorText, foldersUrl, gitInitErrorText } from '../folders.js'
import type { FolderListing } from '../folders.js'
import { Button, Icon, IconButton, Spinner } from './ui.js'

export interface NewProject {
  path: string
  defaultBranch: string
  container: boolean
}

/**
 * 加入專案: pick a folder of this computer (the server lists folder names only), then add it. A git repository goes
 * straight to its settings; anything else offers `git init` here, after a confirmation, or going back.
 */
export function AddProjectDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void
  /** Adds the project; throws with the reason when it cannot. */
  onAdd: (project: NewProject) => Promise<void>
}) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [pathText, setPathText] = useState('')
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState('')
  // The folder picked, once the owner moved on from browsing.
  const [chosen, setChosen] = useState<{ path: string; isGit: boolean } | null>(null)
  const [confirmingInit, setConfirmingInit] = useState(false)
  const [branch, setBranch] = useState('main')
  const [container, setContainer] = useState(false)
  const [busy, setBusy] = useState(false)
  // Only the answer to the newest request is used, so a slow listing cannot replace a newer one.
  const latest = useRef(0)
  // Whether the owner typed in the path box since the last listing was asked for: a late answer must not erase it.
  const typed = useRef(false)

  const open = useCallback(async (path?: string) => {
    const ticket = ++latest.current
    typed.current = false
    setLoading(true)
    setFailure('')
    try {
      const next = await request<FolderListing>(foldersUrl(path))
      if (ticket !== latest.current) return
      setListing(next)
      if (!typed.current) setPathText(next.path)
    } catch (cause) {
      if (ticket === latest.current) setFailure(folderErrorText(cause))
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void open()
  }, [open])

  // On the window, not the dialog: after a step the focused button is gone, and Esc must still close it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function go(event: FormEvent) {
    event.preventDefault()
    void open(pathText)
  }

  function choose(path: string, isGit: boolean) {
    setChosen({ path, isGit })
    setConfirmingInit(false)
    setFailure('')
  }

  async function initHere() {
    if (!chosen) return
    setBusy(true)
    setFailure('')
    try {
      const made = await request<{ path: string; defaultBranch: string }>('/api/fs/git-init', {
        method: 'POST',
        body: JSON.stringify({ path: chosen.path, confirm: true }),
      })
      setChosen({ path: made.path, isGit: true })
      setBranch(made.defaultBranch)
      setConfirmingInit(false)
    } catch (cause) {
      setConfirmingInit(false)
      setFailure(gitInitErrorText(cause))
    } finally {
      setBusy(false)
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!chosen) return
    setBusy(true)
    setFailure('')
    try {
      await onAdd({ path: chosen.path, defaultBranch: branch.trim() || 'main', container })
    } catch (cause) {
      setFailure(errorMessage(cause, '無法加入專案'))
      setBusy(false)
    }
  }

  const title = (
    <div className="dialog-header">
      <h2 id="repo-dialog-title">加入專案</h2>
      <IconButton icon="x" label="關閉" onClick={onClose} />
    </div>
  )

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="dialog folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-dialog-title"
      >
        {title}
        {chosen ? (
          <form className="field-stack" onSubmit={(event) => void add(event)}>
            <p className="folder-chosen" title={chosen.path}>
              <Icon name={chosen.isGit ? 'branch' : 'folder'} size={14} />
              <span>{chosen.path}</span>
            </p>
            {chosen.isGit ? (
              <>
                <label>
                  預設分支
                  <input
                    aria-label="預設分支"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    required
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    aria-label="在容器裡執行 agent"
                    checked={container}
                    onChange={(event) => setContainer(event.target.checked)}
                  />
                  在容器裡執行 agent（需要 Docker）
                </label>
              </>
            ) : confirmingInit ? (
              <p className="folder-confirm" role="alert">
                要在這個資料夾建立 git 專案嗎？
              </p>
            ) : (
              <p className="folder-confirm">這個資料夾還不是 git 專案</p>
            )}
            {failure ? (
              <p className="form-error" role="alert">
                {failure}
              </p>
            ) : null}
            <div className="dialog-actions">
              {chosen.isGit ? (
                <>
                  <Button variant="ghost" onClick={() => setChosen(null)} disabled={busy}>
                    返回
                  </Button>
                  <Button variant="primary" type="submit" disabled={busy}>
                    加入專案
                  </Button>
                </>
              ) : confirmingInit ? (
                <>
                  <Button variant="ghost" onClick={() => setConfirmingInit(false)} disabled={busy}>
                    取消
                  </Button>
                  <Button variant="primary" onClick={() => void initHere()} disabled={busy}>
                    確認 git init
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => setChosen(null)}>
                    返回
                  </Button>
                  <Button variant="primary" onClick={() => setConfirmingInit(true)}>
                    在這裡 git init
                  </Button>
                </>
              )}
            </div>
          </form>
        ) : (
          <div className="field-stack">
            <form className="folder-path" onSubmit={go}>
              <input
                aria-label="資料夾路徑"
                value={pathText}
                placeholder="貼上路徑"
                spellCheck={false}
                autoFocus
                onChange={(event) => {
                  typed.current = true
                  setPathText(event.target.value)
                }}
              />
              <Button type="submit" variant="secondary" disabled={loading}>
                前往
              </Button>
            </form>
            {listing ? (
              <nav className="folder-crumbs" aria-label="目前位置">
                <IconButton
                  icon="arrow-up"
                  label="上一層"
                  className="icon-btn-sm"
                  disabled={listing.parent === null || loading}
                  onClick={() => void open(listing.parent ?? undefined)}
                />
                {listing.crumbs.map((crumb, index) => (
                  <span className="folder-crumb" key={crumb.path}>
                    {index > 0 ? <Icon name="chevron-right" size={12} /> : null}
                    <button
                      type="button"
                      aria-current={index === listing.crumbs.length - 1 ? 'location' : undefined}
                      disabled={loading}
                      onClick={() => void open(crumb.path)}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </nav>
            ) : null}
            <div className="folder-list" aria-busy={loading}>
              {listing === null ? (
                loading ? (
                  <div className="folder-empty">
                    <Spinner />
                  </div>
                ) : null
              ) : listing.folders.length === 0 ? (
                <p className="folder-empty">沒有子資料夾</p>
              ) : (
                <ul>
                  {listing.folders.map((folder) => (
                    <li key={folder.path}>
                      <button
                        type="button"
                        className="folder-row"
                        disabled={loading}
                        onClick={() => void open(folder.path)}
                      >
                        <Icon name={folder.isGit ? 'branch' : 'folder'} size={14} />
                        <span className="folder-name">{folder.name}</span>
                      </button>
                      {folder.isGit ? (
                        <button
                          type="button"
                          className="folder-pick"
                          aria-label={`加入：${folder.name}`}
                          disabled={loading}
                          onClick={() => choose(folder.path, true)}
                        >
                          選擇
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {listing?.truncated ? <p className="folder-empty">只顯示前 500 個資料夾</p> : null}
            </div>
            {failure ? (
              <p className="form-error" role="alert">
                {failure}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button variant="ghost" onClick={onClose}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!listing || loading}
                onClick={() => listing && choose(listing.path, listing.isGit)}
              >
                選擇這個資料夾
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
