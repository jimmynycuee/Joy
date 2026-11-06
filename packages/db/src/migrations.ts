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
    name: 'repository provider allowlists',
    sql: /* sql */ `
      ALTER TABLE repos ADD COLUMN allowed_providers TEXT NOT NULL
        DEFAULT '["openai-api","claude-cli","codex-cli"]'
        CHECK (json_valid(allowed_providers));
    `,
  },
  {
    version: 3,
    name: 'validate repository provider allowlists',
    sql: /* sql */ `
      CREATE TRIGGER repos_allowed_providers_insert
      BEFORE INSERT ON repos
      BEGIN
        SELECT CASE
          WHEN json_type(NEW.allowed_providers) IS NOT 'array'
            THEN RAISE(ABORT, 'repository allowed providers must be an array')
          WHEN json_array_length(NEW.allowed_providers) = 0
            THEN RAISE(ABORT, 'repository allowed providers must contain at least one provider')
          WHEN EXISTS (
            SELECT 1 FROM json_each(NEW.allowed_providers)
            WHERE type != 'text' OR value NOT IN ('openai-api', 'claude-cli', 'codex-cli')
          ) THEN RAISE(ABORT, 'repository allowed providers contain an unknown provider')
          WHEN (SELECT count(*) FROM json_each(NEW.allowed_providers))
            != (SELECT count(DISTINCT value) FROM json_each(NEW.allowed_providers))
            THEN RAISE(ABORT, 'repository allowed providers must be unique')
        END;
      END;

      CREATE TRIGGER repos_allowed_providers_update
      BEFORE UPDATE OF allowed_providers ON repos
      BEGIN
        SELECT CASE
          WHEN json_type(NEW.allowed_providers) IS NOT 'array'
            THEN RAISE(ABORT, 'repository allowed providers must be an array')
          WHEN json_array_length(NEW.allowed_providers) = 0
            THEN RAISE(ABORT, 'repository allowed providers must contain at least one provider')
          WHEN EXISTS (
            SELECT 1 FROM json_each(NEW.allowed_providers)
            WHERE type != 'text' OR value NOT IN ('openai-api', 'claude-cli', 'codex-cli')
          ) THEN RAISE(ABORT, 'repository allowed providers contain an unknown provider')
          WHEN (SELECT count(*) FROM json_each(NEW.allowed_providers))
            != (SELECT count(DISTINCT value) FROM json_each(NEW.allowed_providers))
            THEN RAISE(ABORT, 'repository allowed providers must be unique')
        END;
      END;
    `,
  },
  {
    version: 4,
    name: 'record task-level failures without attempts',
    sql: /* sql */ `
      CREATE TABLE task_events (
        id              INTEGER PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        type            TEXT NOT NULL,
        payload         TEXT NOT NULL CHECK (json_valid(payload)),
        ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (task_id, seq)
      ) STRICT;
      CREATE INDEX task_events_task ON task_events(task_id, seq);
    `,
  },
  {
    version: 5,
    name: 'preserve task provenance for action policy',
    sql: /* sql */ `
      ALTER TABLE tasks ADD COLUMN provenance TEXT NOT NULL DEFAULT 'user'
        CHECK (provenance IN ('user', 'agent', 'external_content'));
    `,
  },
  {
    version: 6,
    name: 'restrict task provenance to request origin',
    sql: /* sql */ `
      UPDATE tasks SET provenance = 'user' WHERE provenance = 'agent';

      CREATE TRIGGER tasks_provenance_insert
      BEFORE INSERT ON tasks
      WHEN NEW.provenance NOT IN ('user', 'external_content')
      BEGIN
        SELECT RAISE(ABORT, 'task provenance must be user or external_content');
      END;

      CREATE TRIGGER tasks_provenance_update
      BEFORE UPDATE OF provenance ON tasks
      WHEN NEW.provenance NOT IN ('user', 'external_content')
      BEGIN
        SELECT RAISE(ABORT, 'task provenance must be user or external_content');
      END;
    `,
  },
  {
    version: 7,
    name: 'assistant conversations keep their model session',
    sql: /* sql */ `
      -- The assistant brain that served the conversation and its session, so the next turn can resume it.
      ALTER TABLE conversations ADD COLUMN brain_provider TEXT;
      ALTER TABLE conversations ADD COLUMN brain_model TEXT;
      ALTER TABLE conversations ADD COLUMN session_id TEXT;
      ALTER TABLE conversations ADD COLUMN updated_at TEXT;
      CREATE INDEX messages_conversation_order ON messages(conversation_id, id);
    `,
  },
  {
    version: 8,
    name: 'remember the conversation that created a task',
    sql: /* sql */ `
      -- Tasks the assistant starts report back to this conversation when they finish.
      ALTER TABLE tasks ADD COLUMN origin_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 9,
    name: 'stable memory keys for full-text search (issue 39) and superseded memories',
    sql: /* sql */ `
      -- FTS was tied to the hidden rowid of a table with a TEXT primary key; VACUUM may renumber that rowid and
      -- point index rows at the wrong memory. Rebuild with an explicit INTEGER PRIMARY KEY the index can rely on.
      DROP TRIGGER memories_ai;
      DROP TRIGGER memories_ad;
      DROP TRIGGER memories_au;
      DROP TABLE memories_fts;
      ALTER TABLE memories RENAME TO memories_old;
      CREATE TABLE memories (
        seq             INTEGER PRIMARY KEY,
        id              TEXT NOT NULL UNIQUE,
        scope           TEXT NOT NULL CHECK (scope IN ('user', 'project', 'episode')),
        repo_id         TEXT REFERENCES repos(id) ON DELETE CASCADE,
        content         TEXT NOT NULL,
        -- Only 'user_utterance' may create user-scope memories (enforced in packages/memory).
        source          TEXT NOT NULL CHECK (source IN ('user_utterance', 'agent', 'summary', 'manual')),
        confidence      REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
        sensitive       INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
        expires_at      TEXT,
        last_used_at    TEXT,
        -- Set when a newer memory contradicted this one; kept for the record, never used again.
        superseded_by   TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
      INSERT INTO memories (id, scope, repo_id, content, source, confidence, sensitive, expires_at, last_used_at, created_at)
        SELECT id, scope, repo_id, content, source, confidence, sensitive, expires_at, last_used_at, created_at
        FROM memories_old;
      DROP TABLE memories_old;
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='seq');
      INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
      END;
    `,
  },
  {
    version: 10,
    name: 'memories used by each assistant session and reply',
    sql: /* sql */ `
      -- The memories given to the conversation's current brain session: deleting or editing one of them must end
      -- that session so the next turn starts without it.
      ALTER TABLE conversations ADD COLUMN memory_ids TEXT CHECK (memory_ids IS NULL OR json_valid(memory_ids));
      -- The memories in play when the assistant wrote this reply (shown next to the reply).
      ALTER TABLE messages ADD COLUMN memory_ids TEXT CHECK (memory_ids IS NULL OR json_valid(memory_ids));
    `,
  },
  {
    version: 11,
    name: 'project note proposals for AGENTS.md',
    sql: /* sql */ `
      -- Joy proposes, the owner applies. base_sha256 is the file the proposal was drawn up against (NULL: no file).
      CREATE TABLE project_notes (
        id              TEXT PRIMARY KEY,
        repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        note            TEXT NOT NULL,
        base_sha256     TEXT,
        proposed        TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'applied', 'rejected', 'conflict')),
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        decided_at      TEXT
      ) STRICT;
      CREATE INDEX project_notes_status ON project_notes(status, created_at);
    `,
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
