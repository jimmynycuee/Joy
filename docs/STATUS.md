# Joy 目前狀態

> 給接手的人或 agent：**開工前先讀這份、`AGENTS.md`、`docs/PLAN.md`。收工前更新這份。**
> 這裡只寫 PLAN 沒有的東西：現在做到哪、卡在哪、下一步、最近的決策。進度打勾在 PLAN 的「進度」。

- 最後更新：2026-11-03
- 目前階段：**P1 進行中**
- 分支：`t0-foundation`（T0.3–T0.6，未合併）→ `t1.1-claude-cli`（疊在 t0 上，未合併）

## 現在的樣子

| 部分                 | 狀態                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| monorepo / CI        | 完成。pnpm、TypeScript 6 strict、ESLint、Prettier、Vitest；CI 在 Ubuntu、macOS、Windows 跑 `pnpm check`  |
| `packages/core`      | 介面定稿（T0.5），說明在 `packages/core/README.md`                                                       |
| `packages/db`        | 完成（T0.6）。`node:sqlite`、migration、FTS5                                                             |
| Claude Code 整合     | 已實測，報告 `docs/spikes/claude-code.md`，fixture 齊全                                                  |
| Codex 整合           | **部分完成**。方式已決定（P1 用 `codex exec --json`），但沒有真實成功執行的 fixture                      |
| `packages/providers` | Claude adapter 完成（T1.1）：fixture contract test、假 CLI 測取消 / 逾時 / 錯誤，真實 CLI 端到端測試通過 |
| 其他套件             | 尚未開始                                                                                                 |

## 卡住 / 需要人做的事

1. **Codex 真實 fixture（T0.4 剩下的部分）**：要在已登入 ChatGPT 訂閱的電腦上執行
   `node scripts/record-fixtures.mjs codex`，把 `tests/fixtures/cli-events/codex/` 的結果 commit。
   之前的測試環境連不到 OpenAI。T1.2 開工前必須完成。
2. **用使用者的訂閱重錄 Claude fixture**：`node scripts/record-fixtures.mjs claude`。
   現有的是在雲端環境錄的，格式應相同，但 `init` 事件的 plugins / skills 會不同。非必要。
3. **Windows 實機**：兩個 CLI 在 Windows 原生能否用 `spawn`（`.cmd` shim 或原生執行檔）尚未確認。T1.1 / T1.2 處理。
4. **確認可用的模型名稱**，更新 `docs/PLAN.md` §3.3 的預設值。

## 下一步

- 合併 `t0-foundation`、`t1.1-claude-cli`。
- **人工審核**：T1.1 在 `packages/core` 的 `done` 事件加了 `structured` 欄位（Claude 的 `--json-schema` 結果）。
- 接著做 T1.4（worktree）、T1.10（keychain）、T1.11（設定），都不依賴 Codex。之後 T1.5（交叉審查）可以先用兩個 Claude 角色或假 provider 開發。
- T1.2（codex adapter）等上面第 1 點完成。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                | 原因 / 出處                                                                               |
| ---------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 2026-11-03 | `session_started` 一定是第一個事件：Claude 在 init 前送的事件先暫存 | 真實 fixture 裡 `active_goal`、`autocompact_state` 在 init 之前                           |
| 2026-11-03 | Claude 不傳 `--include-partial-messages`，`stream_event` 一律丟棄   | 一次任務 170+ 個逐字事件，存進 DB 沒有價值；UI 串流之後再評估                             |
| 2026-11-03 | 沒有 approvalTool 時一律加 `--permission-prompts none`              | headless 沒人回答，寧可拒絕也不要卡住                                                     |
| 2026-11-03 | SQLite 用 Node 內建的 `node:sqlite`，Node 需 ≥ 22.13                | 不用編譯原生模組，Windows 安裝最省事；介面集中在 `packages/db`，必要時可換 better-sqlite3 |
| 2026-11-03 | Codex 在 P1 用 `codex exec --json`；P2 評估改 `app-server`          | 只有 app-server 有互動式審核與額度資訊。`docs/spikes/codex.md`                            |
| 2026-11-03 | Claude 用 `--permission-prompt-tool` 把審核交給 Joy 的 MCP 工具     | 實測可行，`rm` 被成功攔下。`docs/spikes/claude-code.md`                                   |
| 2026-11-03 | Claude 用 `--session-id` 由 Joy 指定 id                             | 第一次呼叫就知道 id，當機後也能恢復                                                       |
| 2026-11-03 | 認不得的 CLI 事件轉成 `raw`，不丟錯                                 | 實測就看到文件沒寫的事件種類                                                              |
| 2026-11-03 | 授權 BSL 1.1，4 年後轉 Apache-2.0                                   | 保留商業化空間；接受外部 PR 前需 CLA                                                      |
| 2026-11-03 | TypeScript 鎖 6.0                                                   | typescript-eslint 尚未支援 7                                                              |
| 2026-11-03 | 狀態放 repo 的 `docs/STATUS.md`，不放 Obsidian                      | agent 只讀得到 repo；Obsidian 可直接開 `docs/` 當 vault                                   |

## 已知的坑

- `claude -p` 要關閉 stdin，否則會等 3 秒。
- prompt 一定放在 `--` 之後，不然以 `-` 開頭的 prompt 會被當成旗標。
- 真實 CLI 的端到端測試：`JOY_E2E_CLAUDE=1 pnpm vitest run --project providers provider.e2e`（會用掉一點額度）。
- Codex 沒網路時會無限重試，不會自己結束：adapter 一定要有逾時。
- Codex 的 `error` 事件常常只是「重新連線中」，不能一律當失敗。
- Claude 的 MCP 工具呼叫也會送去審核：Joy 自己的工具要預設放行。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
