import type { RepoId, TaskId } from '@joy/core'
import type { Database } from './database.js'

export interface IssueImportRecord {
  repoId: RepoId
  issueNumber: number
  taskId?: TaskId
  trigger: 'label' | 'assistant-command'
  importedAt: string
}

/** Claims an issue for import. False when it was already imported (by either trigger). */
export function claimIssueImport(
  db: Database,
  repoId: RepoId,
  issueNumber: number,
  trigger: IssueImportRecord['trigger'],
): boolean {
  return (
    Number(
      db
        .prepare(
          `INSERT INTO issue_imports (repo_id, issue_number, trigger) VALUES (?, ?, ?)
           ON CONFLICT (repo_id, issue_number) DO NOTHING`,
        )
        .run(repoId, issueNumber, trigger).changes,
    ) === 1
  )
}

export function setIssueImportTask(db: Database, repoId: RepoId, issueNumber: number, taskId: TaskId): void {
  db.prepare('UPDATE issue_imports SET task_id = ? WHERE repo_id = ? AND issue_number = ?').run(
    taskId,
    repoId,
    issueNumber,
  )
}

/** Gives the claim back after a failed import, so a later poll can try again. */
export function releaseIssueImport(db: Database, repoId: RepoId, issueNumber: number): void {
  db.prepare('DELETE FROM issue_imports WHERE repo_id = ? AND issue_number = ? AND task_id IS NULL').run(
    repoId,
    issueNumber,
  )
}

export function getIssueImport(
  db: Database,
  repoId: RepoId,
  issueNumber: number,
): IssueImportRecord | undefined {
  const row = db
    .prepare('SELECT * FROM issue_imports WHERE repo_id = ? AND issue_number = ?')
    .get(repoId, issueNumber) as
    | {
        repo_id: string
        issue_number: number
        task_id: string | null
        trigger: IssueImportRecord['trigger']
        imported_at: string
      }
    | undefined
  if (!row) return undefined
  return {
    repoId: row.repo_id as RepoId,
    issueNumber: row.issue_number,
    ...(row.task_id ? { taskId: row.task_id as TaskId } : {}),
    trigger: row.trigger,
    importedAt: row.imported_at,
  }
}
