# AGENTS.md

Guide for AI coding agents (Codex, Claude Code, …) working on this repository.
`CLAUDE.md` only imports this file, so **this is the single source of truth**: edit here, never there.

## What Joy is

A local-first platform where Claude and GPT split coding work, plus a personal assistant in front of it.
It **orchestrates the official CLIs** (Claude Code, Codex) using the user's own logged-in subscriptions, and calls the
OpenAI API only for cheap, high-frequency work. Every role (assistant brain, orchestrator, implementer, reviewer,
judge, background) can use any backend. The full plan, tickets and acceptance criteria are in `docs/PLAN.md`.

## Working on a ticket

1. **Read `docs/STATUS.md` first**: where the project is, what is blocked, recent decisions, known pitfalls.
2. Read `docs/PLAN.md` and find the ticket you were given (e.g. `T1.3`). Do **only** that ticket.
3. Every acceptance criterion needs a test that proves it.
4. Run `pnpm check` before you finish. It must pass.
5. **Before you stop, update `docs/STATUS.md`** (what changed, what is blocked, next step, new decisions at the top of
   the decisions table) and tick the ticket in `docs/PLAN.md`'s progress list. Rules every future agent must follow go
   in this file instead.
6. One ticket = one branch = one PR. Branch name: `t1.3-short-description`.

## Commands

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `pnpm install`    | Install dependencies (pnpm only, never npm or yarn)   |
| `pnpm check`      | format check + lint + typecheck + test (what CI runs) |
| `pnpm test`       | Vitest across all workspace packages                  |
| `pnpm test:watch` | Vitest in watch mode                                  |
| `pnpm typecheck`  | `tsc --noEmit` in every package                       |
| `pnpm lint`       | ESLint                                                |
| `pnpm format`     | Prettier write                                        |

Run one package's tests: `pnpm vitest run --project core`.

**Anything that calls a real model uses the cheapest model at low effort** (Claude `haiku`, Codex `gpt-6-luna`,
`effort: 'low'`). Those runs test plumbing, not answer quality, and they spend the owner's subscription quota.
Real-CLI e2e tests are opt-in (`JOY_E2E_CLAUDE=1`) and never run in CI.

Re-record CLI fixtures (uses the logged-in account's quota, macOS/Linux/WSL only):
`node scripts/record-fixtures.mjs claude` or `node scripts/record-fixtures.mjs codex`. Then update
`TESTED_CLI_VERSIONS` in `packages/providers/src/versions.ts` (a test enforces it); see `docs/cli-versions.md`.

## Repository layout

```
docs/STATUS.md       current state, blockers, next step, decisions (read first, update last)
docs/PLAN.md         plan, tickets, acceptance criteria
docs/spikes/         what the Claude Code and Codex CLIs actually do; read before touching providers
packages/core        domain types and interfaces. No I/O, no dependencies on other packages
packages/db          SQLite (node:sqlite) connection, schema, migrations
packages/providers   Claude CLI, Codex CLI, OpenAI API → AgentEvent (the only place that spawns CLIs)
packages/executor    git worktree per attempt; `docker run` command for container repos (T4.5)
packages/orchestrator review loop (and later compete mode)
packages/github     commit/push task branches and open draft pull requests
packages/config      ~/.joy/config.yaml
packages/secrets     OS keychain + Redactor
packages/memory      what the assistant remembers and the rules for writing it (owner review)
packages/channels    Telegram (owner-only)
packages/scheduler   reminders and cron jobs, catch-up after sleep (injectable clock for tests)
scripts/             `pnpm joy` CLI (start, doctor, backup, restore, container-*) and fixture recording
docker/              agent image for container mode
packages/*           one package per module (created by its ticket, see PLAN §3.1)
apps/web             React + Vite UI (T1.8)
apps/desktop         Tauri shell (T4.3)
tests/fixtures       recorded CLI event streams for contract tests
```

Planned packages and their tickets: `server` (T1.6, T1.7), `github` (T1.9), `tools` (T2.2), `policy` (T2.3), `channels` (T2.4), `memory` (T3.3–T3.6).
Create a package only when its ticket asks for it.

## Adding a package

Copy the shape of `packages/core`:

- `package.json`: name `@joy/<name>`, `"type": "module"`, `"private": true`, `exports` pointing at `./src/index.ts`,
  a `typecheck` script.
- `tsconfig.json` extending `../../tsconfig.base.json`.
- `vitest.config.ts` with `defineProject({ test: { name: '<name>', include: ['src/**/*.test.ts'] } })`.
- Depend on other packages with `"@joy/core": "workspace:*"`.

Packages are consumed as TypeScript source (no build step yet). Apps that need to run add a bundler/runner in their own
ticket.

## Architecture rules

- **Dependency direction:** `core` ← everything. Packages depend on `core` interfaces, never on each other's
  internals. `server` is the only place that wires implementations together.
- **Local server boundary:** HTTP and WebSocket listeners bind to `127.0.0.1` only. Do not widen to LAN or all
  interfaces unless authenticated remote access is designed and reviewed.
- **CLI integrations live only in `packages/providers`.** Nothing else spawns `claude` or `codex` or parses their
  output. Every adapter is tested against recorded fixtures in `tests/fixtures/cli-events/`; real CLIs are never called
  in unit tests or CI.
- **Never read, store or forward subscription credentials.** The CLIs use whatever the user is logged into.
- **Secrets** (OpenAI key, bot tokens) go in the OS keychain, never in SQLite, config files, logs or events.
- **Content from outside the user** (email, web pages, issues, tool output) is untrusted: it must never be written to
  memory and never trigger an action that needs approval.
- **Cross-platform:** macOS, Windows and Linux are all supported (CI runs all three). Use `node:path`, never
  hard-coded `/`; spawn processes without a shell (`shell: false`) and with argument arrays; no bash-only scripts.
- Model names are configuration, never hard-coded in logic.

## Database

- `node:sqlite` (built into Node ≥ 22.13). Only `packages/db` imports it.
- Schema changes are new migrations appended to `packages/db/src/migrations.ts`. Never edit a shipped migration.
- Tables are `STRICT`; enums and JSON columns have `CHECK` constraints. Keep it that way.

## Code style

- TypeScript strict, ESM only. `import type` for types (lint enforces it).
- Imports between files inside a package use the `.js` extension (`./foo.js`), as in `packages/core`.
- Prefer small pure functions and discriminated unions over classes and inheritance.
- No `any`. Validate untrusted data at the boundary (CLI output, HTTP input, config) before it becomes a typed value.
- Errors: throw `Error` with a message a user can act on; never swallow errors silently.
- Comments explain _why_, not _what_.
- Prettier formats; do not hand-format.

## Tests

- Vitest. Test files sit next to the code: `foo.ts` → `foo.test.ts`.
- Use fakes (fake provider, temp git repos, in-memory SQLite), not mocks of internals.
- Tests must not touch the network, the user's home directory or real CLIs. Use temp directories.
- A bug fix starts with a failing test.

## Human review required

Changes to these need the human owner's review, even after cross-model review:
`packages/core` interfaces, `packages/policy`, channel authentication, secret handling, and memory write rules.
