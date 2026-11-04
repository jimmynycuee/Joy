// Ordered schema migrations. Never edit a migration that has shipped: add a new one.
// The applied version is stored in SQLite's `PRAGMA user_version`.

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: /* sql */ `
      CREATE TABLE repos (
        id              TEXT PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        github_remote   TEXT,
        default_branch  TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        mode            TEXT NOT NULL CHECK (mode IN ('single', 'review_loop', 'compete')),
        role_overrides  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(role_overrides)),
        plan_first      INTEGER NOT NULL DEFAULT 0 CHECK (plan_first IN (0, 1)),
        max_rounds      INTEGER NOT NULL DEFAULT 3,
        status          TEXT NOT NULL CHECK (status IN
                          ('queued', 'running', 'awaiting_approval', 'review_ready', 'done', 'failed', 'cancelled')),
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      CREATE INDEX tasks_status ON tasks(status);

      CREATE TABLE attempts (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        provider        TEXT NOT NULL,
        model           TEXT NOT NULL,
        worktree_path   TEXT,
        branch          TEXT,
        base_commit     TEXT,
        session_id      TEXT,
        status          TEXT NOT NULL CHECK (status IN
                          ('preparing', 'running', 'reviewing', 'fixing', 'succeeded', 'failed', 'cancelled')),
        diff_stats      TEXT CHECK (diff_stats IS NULL OR json_valid(diff_stats)),
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      CREATE INDEX attempts_task ON attempts(task_id);

      -- Every AgentEvent of an attempt, in order. Lets the UI replay a task and lets the server resume one.
      CREATE TABLE events (
        id              INTEGER PRIMARY KEY,
        attempt_id      TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        type            TEXT NOT NULL,
        payload         TEXT NOT NULL CHECK (json_valid(payload)),
        ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (attempt_id, seq)
      ) STRICT;

      CREATE TABLE reviews (
        id                  TEXT PRIMARY KEY,
        attempt_id          TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        reviewer_provider   TEXT NOT NULL,
        reviewer_model      TEXT NOT NULL,
        round               INTEGER NOT NULL,
        approve             INTEGER NOT NULL CHECK (approve IN (0, 1)),
        summary             TEXT NOT NULL,
        findings            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (attempt_id, round)
      ) STRICT;

      CREATE TABLE approvals (
        id              TEXT PRIMARY KEY,
        attempt_id      TEXT REFERENCES attempts(id) ON DELETE SET NULL,
        action          TEXT NOT NULL CHECK (json_valid(action)),
        tier            TEXT NOT NULL CHECK (tier IN ('auto', 'notify', 'approve')),
        status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        decided_via     TEXT,
        note            TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        decided_at      TEXT
      ) STRICT;
      CREATE INDEX approvals_pending ON approvals(status) WHERE status = 'pending';

      CREATE TABLE conversations (
        id              TEXT PRIMARY KEY,
        channel         TEXT NOT NULL,
        title           TEXT,
        summary         TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
        content         TEXT NOT NULL,
        ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      CREATE INDEX messages_conversation ON messages(conversation_id, id);

      CREATE TABLE memories (
        id              TEXT PRIMARY KEY,
        scope           TEXT NOT NULL CHECK (scope IN ('user', 'project', 'episode')),
        repo_id         TEXT REFERENCES repos(id) ON DELETE CASCADE,
        content         TEXT NOT NULL,
        -- Only 'user_utterance' may create user-scope memories (enforced in packages/memory).
        source          TEXT NOT NULL CHECK (source IN ('user_utterance', 'agent', 'summary', 'manual')),
        confidence      REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
        sensitive       INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
        expires_at      TEXT,
        last_used_at    TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE schedules (
        id              TEXT PRIMARY KEY,
        cron            TEXT,
        run_at          TEXT,
        payload         TEXT NOT NULL CHECK (json_valid(payload)),
        enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        last_run_at     TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CHECK ((cron IS NULL) <> (run_at IS NULL))
      ) STRICT;

      CREATE TABLE usage (
        provider          TEXT NOT NULL,
        day               TEXT NOT NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0,
        rate_limit_hits   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, day)
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'project memory proposals',
    sql: /* sql */ `
      CREATE TABLE project_memory_proposals (
        id                  TEXT PRIMARY KEY,
        repo_id             TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        relative_path       TEXT NOT NULL CHECK (relative_path = 'AGENTS.md'),
        source_provenance   TEXT NOT NULL CHECK (json_valid(source_provenance)),
        base_content        TEXT,
        proposed_content    TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending' CHECK
                              (status IN ('pending', 'approved', 'rejected', 'applied', 'stale')),
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        reviewed_at         TEXT,
        applied_at          TEXT
      ) STRICT;
      CREATE INDEX project_memory_proposals_repo ON project_memory_proposals(repo_id, created_at, id);
    `,
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
