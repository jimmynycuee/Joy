# Joy 目前狀態

> 給接手的人或 agent：**開工前先讀這份、`AGENTS.md`、`docs/PLAN.md`。收工前更新這份。**
> 這裡只寫 PLAN 沒有的東西：現在做到哪、卡在哪、下一步、最近的決策。進度打勾在 PLAN 的「進度」。

- 最後更新：2026-11-04
- 目前階段：**P0 收尾 → 準備進入 P1**
- 分支：`t0-foundation`（T0.3–T0.6 與這份文件；尚未合併到 `main`）

## 現在的樣子

| 部分             | 狀態                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| monorepo / CI    | 完成。pnpm、TypeScript 6 strict、ESLint、Prettier、Vitest；CI 在 Ubuntu、macOS、Windows 跑 `pnpm check` |
| `packages/core`  | 介面定稿（T0.5），說明在 `packages/core/README.md`                                                      |
| `packages/db`    | 完成（T0.6）。`node:sqlite`、migration、FTS5                                                            |
| Claude Code 整合 | 已實測，報告 `docs/spikes/claude-code.md`，fixture 齊全                                                 |
| Codex 整合       | **部分完成**。edit / MCP / resume 真實 fixtures 已錄；Windows 原生與模型名稱仍待確認                        |
| 其他套件         | 尚未開始                                                                                                |

## 卡住 / 需要人做的事

1. **T0.4 尚未全數驗收**：真實 edit / MCP / resume fixture 已於 2026-11-04 在已登入 ChatGPT 的 Mac 錄製並檢查；`-c` 的 MCP 注入已在 `exec` 模式實測成功。Windows 原生行為與可用模型名稱仍未確認，rate-limit 行為也沒有測試證據；T0.4 保持未勾選。此分支尚無 `providers` 套件或 Codex provider contract tests。
2. **用使用者的訂閱重錄 Claude fixture**：`node scripts/record-fixtures.mjs claude`。
   現有的是在雲端環境錄的，格式應相同，但 `init` 事件的 plugins / skills 會不同。非必要。
3. **Windows 實機**：兩個 CLI 在 Windows 原生能否用 `spawn`（`.cmd` shim 或原生執行檔）尚未確認。T1.1 / T1.2 處理。
4. **確認可用的模型名稱**，更新 `docs/PLAN.md` §3.3 的預設值。

## 下一步

- 合併 `t0-foundation`。
- **P1 從 T1.1（`providers/claude-cli`）開始**：fixture 已齊，可以直接做 contract test。
- T1.4（worktree）、T1.10（keychain）、T1.11（設定）不依賴 CLI，可以平行做。
- T1.2（codex adapter）可使用已錄製的 fixtures 開始；adapter contract tests 由 T1.2 實作與驗證。Windows 原生與模型名稱仍是 T0.4 的未完成驗收項目。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                            | 原因 / 出處                                                                               |
| ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 2026-11-03 | SQLite 用 Node 內建的 `node:sqlite`，Node 需 ≥ 22.13            | 不用編譯原生模組，Windows 安裝最省事；介面集中在 `packages/db`，必要時可換 better-sqlite3 |
| 2026-11-03 | Codex 在 P1 用 `codex exec --json`；P2 評估改 `app-server`      | 只有 app-server 有互動式審核與額度資訊。`docs/spikes/codex.md`                            |
| 2026-11-03 | Claude 用 `--permission-prompt-tool` 把審核交給 Joy 的 MCP 工具 | 實測可行，`rm` 被成功攔下。`docs/spikes/claude-code.md`                                   |
| 2026-11-03 | Claude 用 `--session-id` 由 Joy 指定 id                         | 第一次呼叫就知道 id，當機後也能恢復                                                       |
| 2026-11-03 | 認不得的 CLI 事件轉成 `raw`，不丟錯                             | 實測就看到文件沒寫的事件種類                                                              |
| 2026-11-03 | 授權 BSL 1.1，4 年後轉 Apache-2.0                               | 保留商業化空間；接受外部 PR 前需 CLA                                                      |
| 2026-11-03 | TypeScript 鎖 6.0                                               | typescript-eslint 尚未支援 7                                                              |
| 2026-11-03 | 狀態放 repo 的 `docs/STATUS.md`，不放 Obsidian                  | agent 只讀得到 repo；Obsidian 可直接開 `docs/` 當 vault                                   |

## 已知的坑

- `claude -p` 要關閉 stdin，否則會等 3 秒。
- Codex 沒網路時會無限重試，不會自己結束：adapter 一定要有逾時。
- Codex 的 `error` 事件常常只是「重新連線中」，不能一律當失敗。
- Claude 的 MCP 工具呼叫也會送去審核：Joy 自己的工具要預設放行。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
