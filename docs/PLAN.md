# Joy 實作計畫

> 多模型協作的 coding agent 平台 + 個人助理。
> Claude 與 GPT 分工、每一層可自由切換模型、Codex 風格介面、跑在自己電腦上用自己的訂閱。

- 版本：v0.1（2026-11-03）
- 開發方式：主要由 Claude Code / Codex 撰寫，人負責決策、審核、驗收
- 投入：每週 10–20 小時
- 授權：Business Source License 1.1（原始碼公開，非 OSI 開源），見 `LICENSE`
- 參考：[reason-machines/reason-network](https://github.com/reason-machines/reason-network)（agent 之間的 MCP 訊息、`ask_user` 審核、session 狀態可視化）

---

## 0. 怎麼使用這份計畫

1. 把這份檔案放進新 repo 的 `docs/PLAN.md`。
2. 每次開一個 agent session 只做**一張 ticket**（如 `T1.3`），提示詞：「讀 `docs/PLAN.md` 與 `AGENTS.md`，完成 T1.3，所有驗收條件必須有測試」。
3. 一家寫、另一家 review（MVP 完成前手動做；完成後由平台自己做 → dogfooding）。
4. ticket 完成就在本檔打勾，並把學到的慣例寫回 `AGENTS.md`。

### 進度
- [x] T0.1 monorepo、TypeScript strict、ESLint、Prettier、Vitest、三平台 CI
- [x] T0.2 `AGENTS.md` / `CLAUDE.md`
- [x] T0.3 Spike：Claude Code headless（`docs/spikes/claude-code.md`）
- [ ] T0.4 Spike：Codex（`exec --json` 已選定；PR #3 最新 patch 記錄 2026-11-04 在已登入 macOS 上錄到真實 edit、MCP、resume fixtures；原生 Windows、可用模型清單與 rate-limit 行為仍未驗證，ticket 未完成）
- [x] T0.5 定稿 `packages/core` 介面
- [x] T0.6 `packages/db`
- [x] T1.1 `providers/claude-cli`
- [x] T1.2 `providers/codex-cli`（依 SDK 型別與合成 fixture 測試；**錄到真實 fixture 後要重跑 contract test**）
- [x] T1.3 `providers/openai-api`
- [x] T1.4 `executor/worktree`
- [x] T1.5 `orchestrator/review-loop`（PR #31 增加 planFirst resume 失敗回歸測試；真實 Codex CLI read-only resume 仍未驗證）
- [x] T1.10 機密存 OS 鑰匙圈（`packages/secrets`）
- [x] T1.11 設定（`packages/config`；UI 設定頁併入 T1.8）
- [x] T1.6 server（HTTP + WebSocket、任務 CRUD、重啟恢復）
- [x] T1.7 事件紀錄（寫入 DB、可回放、經 Redactor 遮罩）
- [x] T1.9 GitHub：push 分支、開 draft PR
- [x] T1.8 Codex 風格 Web UI（含設定頁）
- [x] T2.1 多 provider 平行競賽（含獨立 worktree 的自動 strengths 合成候選；fake-provider 測試通過）
- [x] T2.2 Tool Hub MCP 第一批工具（`ask_peer`、`task_status`、`request_approval`）
- [x] T3.3 `memory`：三層記憶、安全的直接使用者 utterance 擷取、敏感資訊過濾、信心度與過期（PR #14 仍待 owner review；`github_pat_…` 過濾修補在獨立 draft PR #32，尚待 owner review / integration）
- [ ] T3.4 `memory` 管理 API slice：list / view / edit / delete 已實作；每則回答的記憶引用標示仍 blocked，待 production assistant/chat route 與 answer-reference contract
- [ ] T3.5 專案記憶提案：已實作 `AGENTS.md` review diff、明確 review/apply approval 與安全寫入 API；production assistant/chat integration 尚未實作，且 memory write behavior 待 owner review
- [x] T3.6 `memory`：只儲存明確經使用者核准的對話摘要，沿用既有 FTS5 索引檢索；舊訊息缺乏來源欄位，故不自動摘要；embedding 延後
- [ ] T3.7 `scheduler`（PR #27 draft 已交付可持久化、重啟後可讀的 queue-only slice；due callback 只 enqueue。T2.3 owner policy 仍阻塞完整 ticket acceptance，保持未勾選）
- [ ] T4.2 PWA + Web Push（PR #17 僅交付 installable PWA foundation；Web Push 未實作）
- [ ] T4.4 Windows 強化（PR #16 有原生 Codex 探測與 WSL fallback；installer/distribution 仍是 ticket gap）

目前狀態、卡住的事與下一步：見 [`docs/STATUS.md`](STATUS.md)。

---

## 1. 產品定義

### 1.1 核心功能（使用者提出）
| 功能 | 定義 |
|---|---|
| Claude 與 GPT 分工 | 交叉審查、規劃→實作、平行競賽、`ask_peer` 互相諮詢 |
| 自選主模型 | 每個「角色」（助理大腦 / orchestrator / implementer / reviewer / 裁判 / 背景工作）都能選任一後端與模型，可全域設定、可每個任務覆寫 |
| 介面參考 Codex | 左側任務清單、中間對話與 agent 執行紀錄、右側 diff；一鍵開 PR；多個嘗試並排比較 |
| 程式碼放 GitHub | 平台本身原始碼公開（BSL 1.1，4 年後轉 Apache-2.0）；任務產出以 branch / PR 交付 |

### 1.2 討論後新增的功能
| 功能 | 為什麼需要 |
|---|---|
| **個人助理（Dot 型）** | 平台的「前門」：手機聊天、派工、追進度、行事曆、Email、提醒、查資料 |
| **Model Provider 抽象層** | 自由切換 OpenAI API / Claude CLI / Codex CLI（之後可加 Anthropic API、Gemini） |
| **統一的工具層（自建 MCP server）** | 換大腦不必重寫工具；CLI 與 API 共用同一套工具 |
| **三級權限 + 審核流程** | 🟢 自動 / 🟡 通知後執行 / 🔴 必須審核；手機按鈕 Approve / Deny |
| **跨模型預審** | 🔴 動作交給你之前先讓另一家 review |
| **git worktree 隔離** | 多任務、平行競賽互不干擾 |
| **記憶系統（三層）** | 使用者 / 專案 / 事件記憶；Claude 與 GPT 共用 |
| **Channel adapter** | Telegram + Web 先做，LINE / Discord 之後 |
| **背景排程器** | 主動提醒、定時任務（如每天早上整理 Email、晚上跑任務） |

### 1.3 我額外建議加入的功能（已排進階段）
| 功能 | 說明 | 階段 |
|---|---|---|
| **額度感知與自動備援** | 偵測 CLI 撞到訂閱用量上限（rate limit 訊息）→ 自動改派給另一家，或排隊等額度恢復；顯示 API 額度已用多少（330 美元預算警戒線） | P2 |
| **Session 恢復** | server 重啟或當機後，進行中的任務可從 CLI 的 session id resume，不會白做 | P1 |
| **完整事件紀錄** | 每個任務的所有 agent 事件存檔，可回放、可搜尋，方便除錯與比較兩家表現 | P1 |
| **模型表現統計** | 記錄每家在哪類任務的成功率、被 review 抓到的問題數、耗時，作為選主模型的依據 | P3 |
| **GitHub Issue → 任務** | 對 issue 加 label 或在助理說「做 #12」就建立任務 | P2 |
| **機密管理** | API key / bot token 存在 OS keychain（macOS Keychain、Windows Credential Manager），不進 SQLite、不進 log | P1 |
| **成本保險絲** | 單一任務的 API 花費 / 輪數 / 時間上限，超過就停並通知 | P2 |
| **Remote MCP endpoint** | 讓 ChatGPT、Grok 等外部助理也能派工給你的平台 | P5 |

### 1.4 非目標（明確不做）
- 不把 Claude / ChatGPT 訂閱登入嵌入雲端服務供他人使用（違反條款）。
- MVP 不做帳號系統、計費、多租戶。
- MVP 不做自訂工作流程 DSL（等用出規律再抽象）。
- 不自己實作 coding agent loop（直接編排官方 CLI）。

---

## 2. 關鍵限制與前提

| 限制 | 影響 |
|---|---|
| 訂閱只能本人使用 | 本機執行為主；商業化只能賣「軟體 / 雲端控制層」或改用使用者自己的 API key |
| 不另外花錢 | 重度工作走訂閱 CLI；高頻輕量工作用 GPT API 額度（330 美元）的小模型 |
| CLI 介面會改版 | 所有 CLI 整合集中在 adapter，搭配 contract test 與錄製的事件 fixture，改版時只修一處 |
| Windows 支援 | 跨平台行程管理與路徑處理；Codex 原生 Windows 支援不完整時改走 WSL |
| 條款會變 | 商業化前重新確認 Anthropic / OpenAI 最新使用條款（特別是 Agent SDK 與 Codex 的登入方式） |

---

## 3. 系統架構

```
 手機 / 瀏覽器                     外部助理（P5）
 ┌────────────┐ ┌──────────┐      ┌───────────────┐
 │ Telegram   │ │ Web UI   │      │ ChatGPT/Grok  │
 └─────┬──────┘ └────┬─────┘      └──────┬────────┘
       │ Channel     │ HTTP+WS            │ Remote MCP
 ┌─────▼─────────────▼─────────────────────▼──────────────────────┐
 │                    Joy Server（本機 Node）                       │
 │                                                                 │
 │  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐   │
 │  │ Assistant   │  │ Orchestrator │  │ Approval / Policy     │   │
 │  │ (助理大腦)   │─▶│ (分工模式)    │◀▶│ 🟢🟡🔴 + 模式切換      │   │
 │  └──────┬──────┘  └──────┬───────┘  └───────────────────────┘   │
 │         │                │                                      │
 │  ┌──────▼────────────────▼───────┐  ┌───────────────────────┐   │
 │  │ Model Provider 抽象層           │  │ Tool Hub (MCP server) │   │
 │  │ openai-api │ claude-cli │codex-cli│ │ 派工/查進度/ask_peer/ │   │
 │  └──────┬─────────┬──────────┬───┘  │ 記憶/行事曆/Email/提醒 │   │
 │         │         │          │      └───────────────────────┘   │
 │  ┌──────▼──┐ ┌────▼─────┐ ┌──▼──────┐  ┌──────────┐ ┌────────┐ │
 │  │OpenAI   │ │claude    │ │codex    │  │Executor  │ │Memory  │ │
 │  │API      │ │(子行程)   │ │(子行程)  │  │worktree/ │ │SQLite  │ │
 │  └─────────┘ └──────────┘ └─────────┘  │docker    │ │+FTS5   │ │
 │                                        └──────────┘ └────────┘ │
 │  Scheduler（提醒/定時任務） · Event Log · Secrets(keychain)      │
 └─────────────────────────────────────────────────────────────────┘
                              │ gh / git
                         ┌────▼────┐
                         │ GitHub  │
                         └─────────┘
```

### 3.1 Monorepo 結構
```
joy/
├─ AGENTS.md                 # 給 Codex 的開發守則（唯一來源）
├─ CLAUDE.md                 # 內容：@AGENTS.md（引用，保持同步）
├─ docs/PLAN.md
├─ packages/
│  ├─ core/                  # 型別、領域模型、介面（無 I/O）
│  ├─ providers/             # openai-api / claude-cli / codex-cli adapters
│  ├─ executor/              # worktree（之後 docker）
│  ├─ orchestrator/          # 分工模式：review-loop / compete / ask-peer
│  ├─ tools/                 # 自建 MCP server（Tool Hub）
│  ├─ memory/                # 記憶擷取、檢索、防護
│  ├─ channels/              # web / telegram（之後 line）
│  ├─ policy/                # 權限、審核
│  ├─ db/                    # SQLite schema + migrations（drizzle 或 kysely）
│  └─ server/                # HTTP + WebSocket，組裝以上模組
├─ apps/
│  ├─ web/                   # React + Vite（Codex 風格 UI）
│  └─ desktop/               # Tauri 殼（P4）
└─ tests/
   ├─ fixtures/cli-events/   # 錄下來的 CLI 事件串流，做 contract test
   └─ e2e/
```

### 3.2 核心介面（P0 先定型，所有 ticket 依賴它）
```ts
// packages/core/src/provider.ts
export type ProviderKind = 'openai-api' | 'claude-cli' | 'codex-cli' // 之後: 'anthropic-api'
export interface ModelRef { provider: ProviderKind; model: string }  // 例 { provider:'claude-cli', model:'opus' }

export type AgentEvent =
  | { type: 'message'; role: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | { type: 'file_change'; path: string; kind: 'add' | 'modify' | 'delete' }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'rate_limited'; retryAfterSec?: number; raw: string }
  | { type: 'approval_request'; action: ProposedAction }
  | { type: 'done'; sessionId: string; summary?: string }
  | { type: 'error'; message: string; recoverable: boolean }

export interface RunOptions {
  cwd: string                    // worktree 路徑
  prompt: string
  resumeSessionId?: string
  mcpServers?: McpServerConfig[] // 注入 Tool Hub
  autonomy: 'read-only' | 'workspace-write' | 'full'
  signal: AbortSignal
}

export interface AgentProvider {
  kind: ProviderKind
  capabilities: { codeEdit: boolean; tools: boolean; resume: boolean; streaming: boolean }
  run(opts: RunOptions, model: ModelRef): AsyncIterable<AgentEvent>
  healthCheck(): Promise<{ ok: boolean; loggedIn: boolean; version?: string; detail?: string }>
}

// packages/core/src/executor.ts
export interface Executor {
  prepare(repo: RepoRef, task: TaskId, attempt: number): Promise<Workspace> // 建 worktree + branch
  diff(ws: Workspace): Promise<UnifiedDiff>
  cleanup(ws: Workspace): Promise<void>
}

// packages/core/src/channel.ts
export interface Channel {
  id: 'web' | 'telegram' | 'line'
  send(to: UserRef, msg: OutboundMessage): Promise<void>        // 支援按鈕
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
}

// packages/core/src/policy.ts
export type Tier = 'auto' | 'notify' | 'approve'
export interface ProposedAction { kind: ActionKind; summary: string; detail: unknown; risk: Tier }
```

### 3.3 角色與模型設定（自由切換的落地方式）
```yaml
# ~/.joy/config.yaml（UI 可編輯）
roles:
  assistant_brain:  { provider: openai-api, model: gpt-6-luna, effort: low }   # 高頻、便宜
  background:       { provider: openai-api, model: gpt-6-luna, effort: low }   # 記憶擷取、摘要、分類
  orchestrator:     { provider: claude-cli, model: opus, effort: high }        # 「主模型」
  implementer:      { provider: claude-cli, model: opus, effort: medium }
  reviewer:         { provider: codex-cli,  model: gpt-6.1-sol, effort: medium }
  judge:            { provider: codex-cli,  model: gpt-6.1-sol, effort: medium }
fallback:
  on_rate_limit: swap_provider   # swap_provider | queue | fail
budget:
  openai_api_usd_monthly_cap: 30
  per_task: { max_rounds: 3, max_minutes: 60, max_api_usd: 1 }
autonomy_mode: normal            # careful | normal | hands-off
```
> 模型名稱以 P0 的 spike 實測為準；設定檔只存 `provider + model` 字串，不寫死在程式裡。
> 每個任務可在建立時覆寫任一角色。

### 3.4 CLI 整合方式（P0 spike 驗證）
| CLI | 呼叫方式（待驗證） | 取得事件 | 恢復 | 注入工具 |
|---|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose`（必要時 `--input-format stream-json` 做多輪） | stdout JSONL | `--resume <id>` | `--mcp-config` |
| Codex | `codex exec --json`，或 `codex app-server`（JSON-RPC，較適合長時互動），或官方 TS SDK | stdout JSONL / JSON-RPC | `codex exec resume` | `~/.codex/config.toml` 的 `mcp_servers` 或 `-c` 覆寫 |

**原則：** 兩個 CLI 都使用使用者本機已登入的訂閱；平台不讀取、不保存任何訂閱憑證。

---

## 4. 資料模型（SQLite）

| 表 | 主要欄位 |
|---|---|
| `repos` | id, path, github_remote, default_branch |
| `tasks` | id, repo_id, title, prompt, mode(`single`/`review_loop`/`compete`), role_overrides(json), status, created_at |
| `attempts` | id, task_id, provider, model, worktree_path, branch, session_id, status, diff_stats |
| `events` | id, attempt_id, seq, type, payload(json), ts — 任務完整紀錄 |
| `reviews` | id, attempt_id, reviewer_provider, round, verdict, findings(json) |
| `approvals` | id, action(json), tier, status, decided_by, channel, decided_at |
| `conversations` / `messages` | 助理對話（channel、角色、內容） |
| `memories` | id, scope(`user`/`project`/`episode`), content, source(`user_utterance`/…), confidence, expires_at, sensitive_flag, last_used_at |
| `memories_fts` | FTS5 虛擬表 |
| `schedules` | id, cron / run_at, payload, enabled |
| `usage` | provider, date, tokens, cost_usd, rate_limit_hits |
| `model_stats` | provider, task_kind, success, review_issues, duration（P3） |

---

## 5. Codex 風格 UI

```
┌──────────────┬───────────────────────────────────┬──────────────────────┐
│ ＋ 新任務     │ 任務：修正登入 token 過期            │ Diff | 檔案 | 審查     │
│ ────────────│ 主模型 Claude ▾ 審查 GPT ▾  模式 ▾    │                      │
│ ● 進行中 (2) │ ──────────────────────────────────│  src/auth.ts          │
│   修正登入…  │ 🟣 Claude：讀了 auth.ts…           │  - if (exp < now)     │
│   重構 API…  │   ▸ tool: Bash `pnpm test` ✓      │  + if (exp <= now)    │
│ ○ 待審核 (1) │ 🟢 GPT review 第 1 輪：2 個問題     │                      │
│ ✓ 完成       │ 🟣 Claude：已修正                   │ [嘗試 A] [嘗試 B]     │
│              │ ──────────────────────────────────│                      │
│ 額度 Claude ▮▮▯│ ⚠ 等待審核：push 到 feature 分支   │ [開 PR] [丟棄] [重跑]  │
│ 額度 API $4/30│   [Approve] [Deny]                │                      │
└──────────────┴───────────────────────────────────┴──────────────────────┘
```
- 新任務對話框：選 repo、輸入需求、選模式、選各角色模型（預設帶入設定）。
- 平行競賽：右側用分頁切換多個嘗試，可並排比較 diff，選一個或「合併兩者優點」（交給裁判模型）。
- 全域：額度 / 花費、autonomy 模式切換、provider 健康狀態（是否已登入）。

---

## 6. 分階段計畫

時程以每週約 15 小時估算。每個階段結束都要有**自己能用的版本**。

### P0 — 地基與技術驗證（第 1–2 週）
| ticket | 內容 | 驗收條件 |
|---|---|---|
| T0.1 | 建立 pnpm monorepo、TypeScript strict、ESLint、Prettier、Vitest、GitHub Actions CI（macOS + Windows + Linux 矩陣） | `pnpm test` / `pnpm lint` / `pnpm typecheck` 在三個平台的 CI 都通過 |
| T0.2 | 撰寫 `AGENTS.md`（架構、指令、慣例、禁止事項），`CLAUDE.md` 只放 `@AGENTS.md` | 兩家 agent 開新 session 都能說出專案架構 |
| T0.3 | **Spike：Claude Code headless** — 跑一個改檔任務，錄下完整 stream-json 到 `tests/fixtures/cli-events/claude/` | 文件記錄：事件種類、session id 取得方式、resume、rate limit 時的輸出、MCP 注入方式 |
| T0.4 | **Spike：Codex** — 比較 `codex exec --json` / `app-server` / TS SDK，選定一種；錄 fixture | 同上；並記錄 Windows 原生是否可用 |
| T0.5 | 依 spike 結果定稿 `packages/core` 介面（§3.2） | 型別編譯通過；有 README 說明每個事件 |
| T0.6 | `packages/db`：schema + migration 工具 | 測試可建立空 DB 並跑完 migration |

**P0 風險檢查點：** 若某個 CLI 的 headless 模式無法滿足需求（例如無法注入 MCP），在這裡調整方案，而不是做到一半才發現。

### P1 — MVP：交叉審查寫程式（第 3–8 週）
目標：「在 Web UI 對 repo 下任務 → 主模型在 worktree 寫 → 另一家 review → 修正 → 看 diff → 一鍵開 PR」。

| ticket | 內容 | 驗收條件 |
|---|---|---|
| T1.1 | `providers/claude-cli`：spawn、解析 stream-json → `AgentEvent`、取消、resume、healthCheck | 以 fixture 做 contract test；取消會確實結束子行程（含 Windows） |
| T1.2 | `providers/codex-cli`：同上 | 同上 |
| T1.3 | `providers/openai-api`：Responses API + function calling + 串流 → `AgentEvent`；記錄 usage 與花費 | mock server 測試；花費寫入 `usage` 表 |
| T1.4 | `executor/worktree`：建立 / 列出 / diff / 清除 worktree；跨平台路徑；Windows 長路徑處理 | 同 repo 同時 3 個 worktree 互不干擾；清除後無殘留 |
| T1.5 | `orchestrator/review-loop`：implement → review（結構化 findings JSON）→ fix，最多 N 輪；可選「先出計畫再審」 | 用 fake provider 測完整流程與中止條件 |
| T1.6 | `server`：REST + WebSocket，任務 CRUD、事件串流、啟動時恢復未完成任務（resume） | 重啟 server 後進行中任務可繼續 |
| T1.7 | 事件紀錄：全部 `AgentEvent` 寫入 `events`；可回放 | UI 重新整理後能完整重現任務過程 |
| T1.8 | `apps/web`：React + Vite 三欄 UI、任務清單、WebSocket 即時事件、diff viewer、角色 / 模型選單、設定頁與 OpenAI key 狀態 | 假 provider Playwright e2e 完成建 repo、設定角色模型、建立任務、即時事件與 diff；key 僅存 SecretStore，從不回傳或落入 config / DB / events |
| T1.9 | GitHub：commit、push branch、用 `gh` 開 draft PR，PR 描述附 review 摘要 | 在測試 repo 成功開出 PR |
| T1.10 | 機密：OS keychain 存 OpenAI key（`@napi-rs/keyring` 或同類），log 遮罩 | key 不出現在 DB、log、事件中（測試驗證） |
| T1.11 | 設定：`config.yaml` 讀寫 + UI 設定頁（各角色模型） | 改設定後新任務立即套用 |

**P1 完成後：開始用 Joy 開發 Joy。**

### P2 — 更多分工模式、審核、手機（第 9–12 週）
| ticket | 內容 | 驗收條件 |
|---|---|---|
| T2.1 | `orchestrator/compete`：多個 provider 平行做同一任務，各自 worktree；裁判模型比較；可「合併優點」 | UI 能並排比較並選定；裁判給出理由 |
| T2.2 | `tools`：Tool Hub MCP server 第一批工具：`ask_peer`、`task_status`、`request_approval` | Claude 任務中呼叫 `ask_peer` 能得到 Codex 的回答 |
| T2.3 | `policy`：三級權限、動作分類、全域模式切換；🔴 動作先跨模型預審 | 每類動作都有測試覆蓋其等級 |
| T2.4 | `channels/telegram`：綁定你的帳號（只接受你的 chat id）、通知、Approve / Deny 按鈕 | 在手機上核准 push 後任務繼續 |
| T2.5 | 額度感知：偵測 `rate_limited` → 依設定換家 / 排隊；UI 顯示額度與 API 花費；成本保險絲 | 模擬 rate limit 時自動切換 |
| T2.6 | GitHub Issue → 任務（label 觸發或指令觸發） | 加 label 後自動建立任務 |

### P3 — 個人助理與記憶（第 13–18 週）
| ticket | 內容 | 驗收條件 |
|---|---|---|
| T3.1 | `assistant`：對話迴圈，大腦可選任一 provider；CLI 當大腦時透過 MCP 使用 Tool Hub，API 當大腦時轉成 function calling | 三種大腦都能用同一組工具完成「幫我在 X repo 做 Y」 |
| T3.2 | 派工工具：`create_task`、`list_tasks`、`summarize_task`；任務完成主動回報到 Telegram | 從 Telegram 下任務，完成後收到摘要與 PR 連結 |
| T3.3 | `memory`：三層記憶；使用者記憶自動擷取（只採用使用者本人說的話）、敏感資訊過濾、信心度與過期 | 從 Email 內容讀到的「請記住…」不會被寫入（測試） |
| T3.4 | 記憶 UI：檢視 / 編輯 / 刪除；每次回答標示用到哪些記憶，可一鍵刪除 | 管理 slice 覆蓋記憶 list / view / edit / delete；回答引用標示與一鍵刪除仍 blocked，直到有支援的 production chat route 和 per-answer memory-reference contract |
| T3.5 | 專案記憶：只以既有、同 repo 的 project memories 產生 `AGENTS.md` review diff；review 與套用皆需明確使用者確認 | 未經明確確認檔案不變；需 production assistant/chat integration 才算完整 ticket |
| T3.6 | 事件記憶：對話摘要 + FTS5 檢索；（選配）OpenAI embedding 語意搜尋 | 能找回一個月前討論過的決策 |
| T3.7 | `scheduler`：提醒、cron 任務（如「每晚 11 點跑測試修 flaky」） | 重啟後排程仍有效 |
| T3.8 | 整合 Google Calendar / Gmail（現成 MCP server 或官方 API）；寄信、邀請一律 🔴 | 「明天下午有空嗎」能正確回答；寄信必須審核 |
| T3.9 | 模型表現統計與 UI | 可看到兩家在各類任務的表現 |

### P4 — 遠端與桌面化（第 19–22 週）
| ticket | 內容 |
|---|---|
| T4.1 | 遠端存取：token 驗證 + Tailscale 文件（server 預設只綁 127.0.0.1） |
| T4.2 | PWA + Web Push 通知 |
| T4.3 | Tauri 桌面 app：系統匣、開機啟動、原生通知、自動更新 |
| T4.4 | Windows 強化：安裝檔、WSL 偵測與 Codex fallback |
| T4.5 | `executor/docker`：可選的 container 模式（掛載 CLI 憑證、網路政策） |

### P5 — 商業化準備（第 23 週以後，視使用情況決定）
| 項目 | 內容 |
|---|---|
| 條款確認 | 重新確認 Anthropic / OpenAI 最新條款，確定可收費的範圍 |
| 雲端控制層 | 帳號、跨裝置同步、推播轉送、團隊協作（不經手模型費用） |
| Remote MCP endpoint | 讓 ChatGPT、Grok 等外部助理派工（參考 Reason 的 `mcp.reasonmachines.com/mcp`） |
| LINE channel | 評估推播費用後實作 |
| 自訂工作流程 | 把用出來的分工模式抽象成可設定的流程 |
| 雲端 BYOK 模式 | 使用者自帶 API key 的雲端 sandbox 版本（E2B / Modal / Daytona） |

---

## 7. 品質策略（AI 主寫時的安全網）

- **型別優先**：`packages/core` 由人審過才能改；其他套件只依賴介面。
- **Contract test**：每個 CLI adapter 都以錄下的 fixture 測試；CLI 升級時重錄 fixture，差異即為需要修的地方。
- **Fake provider**：orchestrator / UI 測試一律用假的 provider，不燒額度、可重現。
- **e2e 冒煙測試**（手動觸發、會用真實額度）：每週一次跑真實 CLI 的最小任務。
- **CI 三平台矩陣**：macOS、Windows、Linux。
- **雙模型 review**：每個 PR 由非作者那一家 review；🔴 類程式碼（policy、secrets、channels 驗證）必須由你親自看。

### 你需要親自看懂的地方
1. `packages/core` 的介面定義
2. `packages/policy`（什麼動作需要審核）
3. `packages/channels/telegram` 的身分驗證（只接受你）
4. 機密處理（keychain、log 遮罩）
5. 記憶寫入的來源限制

---

## 8. 風險與對策

| 風險 | 可能性 | 對策 |
|---|---|---|
| CLI 改版導致整合壞掉 | 高 | adapter 隔離 + fixture contract test + 鎖定 CLI 版本並在 UI 顯示 |
| 訂閱額度不夠兩家同時跑 | 中 | 額度感知、排隊、自動換家；競賽模式預設關閉 |
| 條款變更 | 中 | 只調度使用者本機已登入的官方 CLI；商業化前法務確認 |
| Prompt injection（Email、網頁、issue） | 中 | 外部內容不得寫入記憶、不得觸發 🔴 動作；工具結果標示為不可信 |
| Windows 上 Codex 支援不足 | 中 | WSL fallback；P0 先驗證 |
| 範圍膨脹（助理功能） | 高 | 嚴格照階段走；P1 完成前不碰助理 |
| API 額度燒太快 | 低 | 月預算上限 + 每任務保險絲 + 小模型 |

---

## 9. 待決事項
- [x] 專案名稱：Joy（repo：jimmynycuee/Joy）
- [x] 授權：BSL 1.1（Additional Use Grant 禁止以託管服務形式競爭；4 年後轉 Apache-2.0）。商業化前請律師確認；接受外部 PR 前需設置 CLA
- [x] P0 spike 後確認 Codex 整合方式：P1 用 `exec --json`，P2 評估 `app-server`
- [ ] 確認目前兩家可用的模型名稱，更新 §3.3 預設值
- [ ] LINE 官方帳號的推播額度與費用（以官方最新方案為準）
- [ ] 如需參考 Reason 雲端產品細節，需在 session 網路設定允許 `reasonmachines.com`

---

## 10. 第一週可以馬上做的事
1. 在 GitHub 建立 repo（已建立：jimmynycuee/Joy），把本檔放到 `docs/PLAN.md`。
2. 用 Claude Code 做 T0.1、T0.2；用 Codex review。
3. 自己動手跑一次 T0.3、T0.4 的 spike（這兩張最需要人判斷）。
4. 確認 `claude` 與 `codex` 兩個 CLI 都已登入訂閱：`claude --version`、`codex --version`。
