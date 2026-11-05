# Joy 實作計畫

> 多模型協作的 coding agent 平台 + 個人助理。
> Claude 與 GPT 分工、每一層可自由切換模型、Codex 風格介面、跑在自己電腦上用自己的訂閱。

- 版本：v0.2（2026-11-04）：補齊 P2–P5 的 ticket 與驗收條件、隱私與維運、決策紀錄
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
- [ ] T0.4 Spike：Codex（方式已決定，見 `docs/spikes/codex.md`；**缺真實執行的 fixture**，需在已登入的電腦上錄）
- [x] T0.5 定稿 `packages/core` 介面
- [x] T0.6 `packages/db`
- [x] T1.1 `providers/claude-cli`
- [x] T1.2 `providers/codex-cli`（依 SDK 型別與合成 fixture 測試；**錄到真實 fixture 後要重跑 contract test**）
- [x] T1.3 `providers/openai-api`
- [x] T1.4 `executor/worktree`
- [x] T1.5 `orchestrator/review-loop`
- [x] T1.10 機密存 OS 鑰匙圈（`packages/secrets`）
- [x] T1.11 設定（`packages/config`；UI 設定頁併入 T1.8）
- [ ] T1.6 server（HTTP + WebSocket、任務 CRUD、重啟恢復）
- [ ] T1.7 事件紀錄（寫入 DB、可回放、經 Redactor 遮罩）
- [x] T1.12 repo 的 provider 允許清單（本 PR 分支驗收完成；尚未整合至 main，見 `docs/STATUS.md`）
- [ ] T1.9 GitHub：push 分支、開 draft PR
- [ ] T1.13 `joy doctor` 與首次啟動檢查
- [ ] T1.8 Codex 風格 Web UI（含設定頁）
- [ ] P2（T2.1–T2.8）、P3（T3.1–T3.9）、P4（T4.1–T4.9）、P5（T5.1–T5.7）：見 §6

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
> 模型名稱須以 P0 spike 實測並由擁有者確認；此處名稱在確認前不代表已驗證可用。設定以 `provider + model` 識別模型，角色推理強度另以 `effort` 設定；預設值放在設定檔，不寫死在程式裡。
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
| T1.8 | `apps/web`：三欄式 UI、任務清單、即時事件流、diff viewer、角色 / 模型選單 | 能完成一次完整任務；首頁顯示 T1.13 的檢查結果；Playwright e2e 用 fake provider |
| T1.9 | GitHub：commit、push branch、用 `gh` 開 draft PR，PR 描述附 review 摘要 | 在測試 repo 成功開出 PR |
| T1.10 | 機密：OS keychain 存 OpenAI key（`@napi-rs/keyring` 或同類），log 遮罩 | key 不出現在 DB、log、事件中（測試驗證） |
| T1.11 | 設定：`config.yaml` 讀寫 + UI 設定頁（各角色模型） | 改設定後新任務立即套用 |
| T1.12 | **repo 的 provider 允許清單**：每個 repo 設定可用哪些 provider（預設全部）；建立任務與 resume 前檢查所選角色；T2.1、T2.2、T3.2 新增對應流程時沿用此清單。更新清單只影響之後的新任務、resume 與 provider dispatch preflight，不會取消或動態改變已在執行中的任務。 | 所選角色用到不允許的 provider 時任務直接拒絕，錯誤訊息說明是哪個角色；provider 允許清單與 `PROVIDER_KINDS` 同步受 DB regression 保護。 |
| T1.13 | **`joy doctor` 與首次啟動檢查**：Node 版本、git、gh 登入、`claude` / `codex` 安裝與版本、鑰匙圈、資料目錄可寫；提供首頁可呈現的檢查結果 | 每項回報 OK / 缺少 / 版本未測過，並附修復指令；缺 CLI 時只停用該 provider，不阻止啟動 |

**P1 完成後：開始用 Joy 開發 Joy。**

### P2 — 更多分工模式、審核、手機（第 9–12 週）

| ticket | 內容 | 驗收條件 |
|---|---|---|
| T2.1 | `orchestrator/compete`：多個 provider 在各自 worktree 平行做同一任務 → 各自通過一次交叉審查 → 裁判比較並給理由 → 你選一個，或選「合併」：**裁判在第三個 worktree 重新實作合併版**，再走一次審查 | UI 並排比較 diff 與裁判理由；合併版有自己的分支與審查結果；裁判 provider 遵守 T1.12 允許清單；放棄的 worktree 依 T2.8 清理（假 provider 測試） |
| T2.2 | `tools`：Tool Hub MCP server（stdio），第一批工具 `ask_peer`、`task_status`、`request_approval`、`approve`（權限委派用） | Claude 任務中 `ask_peer` 得到另一家的回答；`ask_peer` 遵守 T1.12 允許清單；**被問的一方唯讀、可看同一個 worktree**；每個任務預設最多 5 次（設定可改），超過時工具回傳錯誤而非靜默失敗；Joy 自己的工具預設放行 |
| T2.3 | `policy`：三級權限、動作分類、全域模式切換；🔴 動作先跨模型預審。Claude 透過 `approve` 工具接入 | 每種 `ActionKind` 都有測試覆蓋其等級與三種模式；來自標記為 `external_content` 內容所提出的動作一律不得自動執行 |
| T2.4 | `channels/telegram`：綁定擁有者（只接受設定的 chat id）、通知、Approve / Deny 按鈕、審核逾時 | 陌生帳號的訊息被丟棄並記錄；在手機核准後任務繼續；逾時預設拒絕 |
| T2.5 | **額度感知與交接**：偵測 `quota: limited`（Claude `rate_limit_event`、OpenAI 429、Codex 錯誤訊息）→ **交接給另一家**：把任務說明、目前 diff、計畫、未解決的審查意見整理成交接摘要，另一家在同一個 worktree 以新 session 接手；兩家都沒額度時排隊，到 `resetsAt` 自動繼續。UI 顯示額度與 API 花費；成本保險絲 | 模擬額度用完時任務改由另一家完成；交接摘要存進事件紀錄；交接不違反 T1.12 的允許清單（不允許時改為排隊）；超過每任務 API 上限時停止並通知 |
| T2.6 | GitHub Issue → 任務（label 觸發或助理指令觸發） | 加 label 後自動建立任務；issue 內容標為 `external_content`，由該內容提出的動作一律不得自動執行 |
| T2.7 | **Codex 改用 `app-server`**：常駐 JSON-RPC client，取代 `exec --json`；接上互動式審核（`item/*/requestApproval` → policy）與額度（`account/rateLimits/*` → `quota` 事件） | 同一組 contract test 通過；Codex 的 🔴 動作會跳出審核；`capabilities.delegatedApproval`、`quotaEvents` 改為 true；`exec` 版本保留為備援 |
| T2.8 | **worktree 清理**：開完 PR 或丟棄後立即清理；閒置超過 14 天（設定可改）的 worktree 在 UI 提示，你確認後清除 | 不會刪除有未推送 commit 的 worktree，除非你確認；磁碟用量顯示在 UI |

### P3 — 個人助理與記憶（第 13–18 週）

| ticket | 內容 | 驗收條件 |
|---|---|---|
| T3.1 | `assistant`：對話迴圈，大腦可選任一 provider；CLI 當大腦時透過 MCP 使用 Tool Hub，API 當大腦時轉成 function calling | 三種大腦用同一組工具完成「幫我在 X repo 做 Y」 |
| T3.2 | 派工工具：`create_task`、`list_tasks`、`summarize_task`、`cancel_task`；完成時主動回報 | 從 Telegram 下任務，完成後收到摘要與 PR 連結；助理派工遵守 T1.12 允許清單 |
| T3.3 | `memory` 擷取：每次對話後由 background 角色（低 effort）判斷要記什麼。**規則**：只採用擁有者本人說的話；偵測 key、密碼、證件號碼、健康與財務資訊並擋下；每條記憶有來源、信心度；暫時性陳述（「這週」「先」）設 14 天過期；與既有記憶矛盾時以新的取代舊的並保留紀錄 | 從 Email、網頁、工具結果讀到的「請記住…」不會寫入；敏感資訊不會寫入；過期記憶不再被使用（測試） |
| T3.4 | 記憶 UI：檢視、編輯、刪除；每次回答標示用到哪些記憶，可一鍵刪除 | 刪除後下一次對話不再使用（e2e） |
| T3.5 | 專案記憶：提議修改 `AGENTS.md` → 以 diff 請你確認 | 未經確認不會寫入 repo |
| T3.6 | 事件記憶：對話摘要 + FTS5 檢索；（選配）OpenAI embedding 語意搜尋 | 能找回一個月前討論過的決策 |
| T3.7 | `scheduler`：提醒、cron 任務。**電腦睡眠或關機後醒來：錯過的提醒立刻送出並標示延遲，錯過的定時任務只補跑最近一次** | 重啟後排程仍有效；模擬睡眠 3 小時後只補跑一次（假時鐘測試） |
| T3.8 | Google 行事曆與 Gmail：**接現成的 MCP server**。選型時檢查維護狀況、權限範圍、是否把資料送到第三方；登入憑證依該 server 的方式存放，Joy 不經手。讀取 🟢；新增自己的行程 🟡；寄信、邀請他人一律 🔴 | 「明天下午有空嗎」正確回答；寄信必須審核；信件內容標為 `external_content`；選型紀錄寫進 `docs/STATUS.md` 的「已確認決策」 |
| T3.9 | 模型表現統計與 UI：各家在各類任務的通過率、審查抓到的問題數、耗時、交接次數 | 可依期間與 repo 篩選 |

### P4 — 遠端、桌面化與維運（第 19–23 週）

| ticket | 內容 | 驗收條件 |
|---|---|---|
| T4.1 | 遠端存取：token 驗證 + Tailscale 文件；server 預設只綁 127.0.0.1，開啟遠端要明確設定 | 沒有 token 的請求一律 401；token 可在 UI 重新產生並讓舊的失效 |
| T4.2 | PWA + Web Push 通知 | 手機加到主畫面後收得到任務完成與審核通知 |
| T4.3 | Tauri 桌面 app：系統匣、開機啟動、原生通知、自動更新 | macOS 與 Windows 安裝檔可安裝、更新、移除 |
| T4.4 | Windows 強化：安裝檔、`.cmd` shim 的 spawn、WSL 偵測與 Codex fallback | Windows 實機完成一次交叉審查任務 |
| T4.5 | `executor/docker`：可選的 container 模式（掛載 CLI 憑證、網路政策） | 不信任的 repo 可在 container 內跑完任務 |
| T4.6 | **CLI 版本管理**：記錄每個 provider 測過的版本範圍；啟動與 `doctor` 遇到未測過的版本時警告；CI 每週用最新版 CLI 重跑 contract test（只解析 fixture，不呼叫模型）；重錄流程寫進文件 | 啟動與 `doctor` 對未測版本顯示警告與重錄指令；每週 CI 用最新版 CLI 跑 fixture contract test 且不呼叫模型；重錄流程有文件 |
| T4.7 | **備份與匯出**：每天自動備份 SQLite（保留 7 份）；匯出任務紀錄與記憶為 JSON；從備份還原 | 還原後資料完整；匯出內容經過 Redactor |
| T4.8 | **除錯 log**：結構化 log 寫到 `~/.joy/logs`，依天輪替、保留 14 天，一律經過 Redactor；UI 可下載最近 log | log 中找不到任何已知 secret（測試） |
| T4.9 | **使用者文件**：README 的安裝、第一次設定、日常使用、疑難排解；隱私說明（見 §7.1） | 新電腦照 README 能在 15 分鐘內跑完第一個任務 |

### P5 — 商業化準備（第 24 週以後，視使用情況決定）

| ticket | 內容 | 驗收條件 |
|---|---|---|
| T5.1 | 條款與法務：重新確認 Anthropic / OpenAI 最新條款與可收費範圍；律師審 BSL 參數 | 書面結論存進 `docs/legal.md` |
| T5.2 | 開放外部貢獻：CLA Assistant、`CONTRIBUTING.md` 改為接受 PR、PR 範本 | 未簽 CLA 的 PR 無法合併 |
| T5.3 | 雲端控制層：帳號、跨裝置同步、推播轉送、團隊協作（**不經手模型費用與訂閱憑證**）；也負責電腦睡眠時的準時推播 | 本機引擎離線時，雲端能收任務並在上線後交付 |
| T5.4 | Remote MCP endpoint：讓 ChatGPT、Grok 等外部助理派工 | 外部助理派的任務標為 `external_content` 並受 policy 限制；由該內容提出的動作一律不得自動執行 |
| T5.5 | LINE channel：先確認當時的推播額度與費用；主動通知合併成摘要以節省訊息數 | 同 T2.4 的驗收條件 |
| T5.6 | 自訂工作流程：把用出來的分工模式抽象成可設定的流程 | 現有三種模式都能用新格式表達 |
| T5.7 | 雲端 BYOK 模式：使用者自帶 API key 的雲端 sandbox（E2B / Modal / Daytona） | 使用者的 key 只存在其帳號的 secret store |

---

## 7. 品質、隱私與維運

### 7.1 隱私（資料會送去哪裡）
- 交叉審查、`ask_peer`、交接都會把程式碼送給**另一家**。敏感 repo 用 T1.12 的允許清單限制只用一家。
- 助理大腦與背景工作走 OpenAI API：對話內容、記憶摘要會送到 OpenAI。
- Gmail / 行事曆內容只在需要時讀取，經過你選的 MCP server（T3.8 選型時確認它是否把資料送到第三方）。
- Joy 不讀取、不保存、不轉送訂閱登入憑證；API key 只存在鑰匙圈。
- 不收集使用統計；P5 雲端層若要收集，必須預設關閉並可選擇加入。

### 7.2 測試與審查
- **型別優先**：`packages/core` 由人審過才能改；其他套件只依賴介面。
- **Contract test**：每個 adapter 都以錄下的 fixture 測試；CLI 升級時重錄（T4.6）。
- **Fake provider**：orchestrator / server / UI 測試一律用假 provider。
- **真實模型測試**：只用最便宜的模型 + low effort，opt-in，不進 CI。
- **CI 三平台矩陣**：macOS、Windows、Linux。
- **雙模型 review**：每個 PR 由非作者那一家 review。

### 7.3 你需要親自看懂的地方
1. `packages/core` 的介面定義
2. `packages/policy`（什麼動作需要審核）
3. `packages/channels` 的身分驗證（只接受你）
4. 機密處理（鑰匙圈、Redactor）
5. 記憶寫入規則（T3.3）
6. repo 允許清單（T1.12）

---

## 8. 風險與對策

| 風險 | 可能性 | 對策 |
|---|---|---|
| CLI 改版導致整合壞掉 | 高 | adapter 隔離 + fixture contract test + 版本範圍警告（T4.6） |
| 訂閱額度不夠兩家同時跑 | 中 | 額度感知、交接給另一家、排隊（T2.5）；競賽模式預設關閉 |
| 條款變更 | 中 | 只調度使用者本機已登入的官方 CLI；商業化前法務確認（T5.1） |
| Prompt injection（Email、網頁、issue） | 中 | 外部內容標為 `external_content`：不得寫入記憶；由該內容提出的動作一律不得自動執行 |
| 程式碼送到不該送的那一家 | 中 | repo 允許清單（T1.12），所有角色與交接都檢查 |
| 第三方 Gmail / 行事曆 MCP server 不可靠或外洩資料 | 中 | 選型檢查清單（T3.8）；寄信一律 🔴；可隨時停用 |
| Codex 在 P1 無法互動審核 | 中（已知） | P1 只在 sandbox 內工作；T2.7 改用 app-server |
| Windows 上 Codex 支援不足 | 中 | WSL fallback（T4.4） |
| 範圍膨脹（助理功能） | 高 | 嚴格照階段走；P1 完成前不碰助理 |
| API 額度燒太快 | 低 | 月預算上限 + 每任務保險絲 + 小模型 |
| 資料遺失 | 低 | 每日備份（T4.7） |

---

## 9. 決策紀錄與待決事項

### 已決定
- [x] 專案名稱：Joy（repo：jimmynycuee/Joy）
- [x] 授權：BSL 1.1（禁止以託管服務競爭；4 年後轉 Apache-2.0）
- [x] Codex 整合：P1 用 `exec --json`，**P2 改用 `app-server`**（T2.7）
- [x] 隱私：**每個 repo 可設允許的 provider**（T1.12）
- [x] 額度用完：**交接給另一家**，兩家都沒額度時排隊（T2.5）
- [x] 競賽合併：**裁判在第三個 worktree 重做**，再審查一次（T2.1）
- [x] Gmail / 行事曆：**接現成的 MCP server**（T3.8）
- [x] 排程遇到睡眠：**醒來後補跑**，定時任務只補最近一次（T3.7）
- [x] 外部貢獻：**暫不接受 PR**，只收 issue；商業化前再設 CLA（T5.2）
- [x] LINE：**P5 商業化時**再做（T5.5）

### 待決（不影響 P1）
- [ ] 確認兩家實際可用的模型名稱，更新 §3.3 與 `packages/config` 預設值
- [ ] T3.8 選定哪一個 Gmail / 行事曆 MCP server
- [ ] T5.5 前確認 LINE 推播費用
- [ ] 如需參考 Reason 雲端產品細節，需在 session 網路設定允許 `reasonmachines.com`

---

## 10. 接下來

目前做到哪、下一步做什麼，以 [`docs/STATUS.md`](STATUS.md) 為準。P1 剩下的順序：
T1.6 + T1.7 → T1.12 → T1.9 → T1.13 → T1.8。
