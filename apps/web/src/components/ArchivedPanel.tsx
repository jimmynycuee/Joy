import { relativeTime } from '../dates.js'
import { shortTitle } from '../labels.js'
import { sortTasksByActivity } from '../recent.js'
import { repoColor } from '../repo-colors.js'
import type { Repo, Task } from '../types.js'
import { Button, ProjectDot } from './ui.js'

/** 設定 → 已封存: archived tasks, each one can be opened or brought back to the sidebar. */
export function ArchivedPanel({
  tasks,
  repos,
  onOpen,
  onRestore,
}: {
  tasks: Task[]
  repos: Repo[]
  onOpen: (id: string) => void
  onRestore: (id: string) => void
}) {
  const archived = sortTasksByActivity(tasks.filter((task) => task.archived))
  return (
    <section className="card settings-card" aria-label="已封存的任務">
      <h2>已封存</h2>
      {archived.length === 0 ? (
        <p className="muted">沒有已封存的任務</p>
      ) : (
        <ul className="archived-list">
          {archived.map((task) => (
            <li key={task.id} className="archived-row">
              <ProjectDot color={repoColor(task.repoId, repos)} />
              <span className="archived-title">{shortTitle(task.title)}</span>
              <span className="muted archived-time">{relativeTime(task.updatedAt || task.createdAt)}</span>
              <Button
                variant="ghost"
                aria-label={`打開：${shortTitle(task.title)}`}
                onClick={() => onOpen(task.id)}
              >
                打開
              </Button>
              <Button
                variant="secondary"
                aria-label={`取消封存：${shortTitle(task.title)}`}
                onClick={() => onRestore(task.id)}
              >
                取消封存
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
