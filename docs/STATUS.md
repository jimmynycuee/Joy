# Joy 目前狀態

> 給接手的人或 agent：**開工前先讀這份、`AGENTS.md`、`docs/PLAN.md`。收工前更新這份。**
> 這裡只寫 PLAN 沒有的東西：現在做到哪、卡在哪、下一步、最近的決策。進度打勾在 PLAN 的「進度」。

- 最後更新：2026-11-03
- 目前階段：**P1 進行中**（T1.1–T1.5、T1.10、T1.11 完成；剩 T1.6、T1.7、T1.8、T1.9）
- 最新分支：`t1.5-review-loop`。它包含之前所有工作，**從這個分支接著做**。

## 分支與 PR（一條直線，每個疊在前一個上）

```
main ← t0-foundation (#2) ← t1.1-claude-cli (#3) ← t1.4-worktree (#4) ← t1.11-config (#5)
     ← t1.10-secrets ← t1.2-codex ← t1.3-openai-api ← t1.5-review-loop
```

- #2–#5 已開 PR，CI 三平台通過，**等擁有者審核**（含 `packages/core` 變更）。
- `t1.10-secrets` 之後的分支已推上 GitHub，**還沒開 PR**。
- 合併方式：依序用 merge commit（不要 squash），每合併一個就把下一個 PR 的 base 改成 `main`。
- agent 沒有合併 PR 的權限（會被權限檢查擋下），合併由擁有者做。

## 現在的樣子

| 部分                    | 狀態                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo / CI           | 完成。pnpm、TypeScript 6 strict、ESLint、Prettier、Vitest；CI 在 Ubuntu、macOS、Windows 跑 `pnpm check`（只在 PR 與推到 main 時觸發）                |
| `packages/core`         | 介面（T0.5），說明在 `packages/core/README.md`                                                                                                       |
| `packages/db`           | T0.6。`node:sqlite`、STRICT schema、migration、FTS5。**還沒有任何讀寫的 repository 函式**，T1.6/T1.7 要加                                            |
| `packages/providers`    | Claude（T1.1，真實 CLI 端到端測過）、Codex（T1.2，只有 SDK 型別與合成 fixture）、OpenAI API（T1.3，假伺服器測過）。共用 `runCli` / `runJsonlProcess` |
| `packages/executor`     | T1.4：每個 attempt 一個 worktree + branch，diff、commit、cleanup                                                                                     |
| `packages/config`       | T1.11 後端：`~/.joy/config.yaml`（`JOY_HOME` 可改），zod 驗證，檔案改了下次讀取就生效                                                                |
| `packages/secrets`      | T1.10：OS 鑰匙圈（`@napi-rs/keyring`）、環境變數覆寫、`Redactor` 遮罩                                                                                |
| `packages/orchestrator` | T1.5：`reviewLoop()`：可選規劃 + 規劃審查 → 實作 → 結構化審查 → 同 session 修正，最多 N 輪                                                           |
| server / UI / GitHub    | 尚未開始（T1.6–T1.9）                                                                                                                                |

## 卡住 / 需要人做的事

1. **Codex 真實 fixture**：擁有者的 Codex 額度暫時不夠。額度恢復後在已登入的電腦上執行
   `node scripts/record-fixtures.mjs codex`（預設用 gpt-6-luna + low effort），commit 結果，
   重跑 `pnpm vitest run --project providers codex`，修正不符的地方，然後刪掉 `synthetic-edit.*`。
2. **審核並合併 PR #2–#5**，再替 `t1.10-secrets` 之後的分支開 PR（或合併成一個 PR）。
3. **確認模型名稱**：預設值（`packages/config/src/schema.ts`）取自 Codex 0.166 的內建清單，擁有者要確認自己帳號可用。
4. Windows 實機尚未手動測過，只靠 CI。

## 下一步（照順序）

1. **T1.6 + T1.7 server 與事件紀錄**（新套件 `packages/server`）
   - 在 `packages/db` 加 repository 函式：repos、tasks、attempts、events、reviews、usage 的讀寫（新增檔案，不要改已有的 migration）。
   - HTTP + WebSocket（建議 Node 內建 `node:http` + `ws`，或 Hono；只綁 `127.0.0.1`）。
   - API：建立 repo、建立任務（選模式與各角色模型）、列出任務、取得任務詳情與事件、取消、WebSocket 訂閱即時事件。
   - 每個 `LoopEvent` / `AgentEvent` 先經過 `Redactor` 再寫入 `events` 表（T1.10 的驗收條件「key 不出現在 DB」在這裡用測試證明）。
   - `usage` 事件累加進 `usage` 表；`quota` 事件記下來給 UI。
   - 重啟時：狀態為 running 的任務標記中斷，可用 attempt 的 `session_id` 以 resume 繼續。
   - 組裝：`ConfigStore` → 角色模型、`SecretStore` → OpenAI key、三個 provider、`WorktreeExecutor`、`reviewLoop`。
   - 測試用假 provider（參考 `packages/orchestrator/src/review-loop.test.ts` 的 `FakeProvider`）。
2. **T1.9 GitHub**：commit、push 分支、`gh pr create --draft`，PR 描述附審查摘要（`formatFindings`）。用本機 bare repo 當 remote、假的 `gh` 腳本測。push 屬於 🟡 等級，MVP 先由 UI 按鈕觸發。
3. **T1.8 Web UI**（`apps/web`，React + Vite）：三欄式（任務清單／即時事件／diff），角色與模型選單，設定頁（含 T1.11 的 UI 與 OpenAI key 輸入），Playwright e2e 用假 provider。
4. P1 完成後：開始用 Joy 開發 Joy。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                                                                     | 原因 / 出處                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 2026-11-03 | 審查結果用 JSON Schema 強制結構化；所有欄位必填、可為 null（OpenAI strict 模式要求）；列出 blocker 卻 approve 視為不通過 | `packages/orchestrator/src/prompts.ts`                                                    |
| 2026-11-03 | 輪數用完仍未通過時結果是 `succeeded` + `approved: false`，交給人決定                                                     | 改動可能已經夠好，不該直接丟掉                                                            |
| 2026-11-03 | reviewLoop 不清理 worktree                                                                                               | 人看完結果、決定開 PR 或丟棄後，由 server 清理                                            |
| 2026-11-03 | OpenAI provider 用 fetch + 自寫 SSE，不用官方 SDK                                                                        | 少一個相依、測試用本機假伺服器即可；價格由設定提供，不寫死                                |
| 2026-11-03 | Codex adapter 依 SDK 型別先寫，用合成 fixture 測                                                                         | 擁有者 Codex 額度不足；錄到真實 fixture 後必須重新驗證                                    |
| 2026-11-03 | 鑰匙圈不可用時錯誤訊息要說明怎麼修，並允許用環境變數                                                                     | 雲端 / 無桌面的 Linux 沒有 Secret Service                                                 |
| 2026-11-03 | 呼叫真實模型的測試一律用最便宜的模型 + low effort（Claude haiku、Codex gpt-6-luna）                                      | 擁有者要求節省訂閱額度；這些測試只驗證串接                                                |
| 2026-11-03 | `ModelRef` 加 `effort`，每個角色可設推理強度                                                                             | 背景工作用 low 省額度，主模型用 high                                                      |
| 2026-11-03 | 設定檔未知的鍵直接報錯                                                                                                   | 通常是打錯字，默默忽略會讓人以為設定生效了                                                |
| 2026-11-03 | 預設模型名稱取自 Codex 0.166 內建清單（`codex debug models`）                                                            | 只是預設值，擁有者應自行確認                                                              |
| 2026-11-03 | worktree 放在 `<worktreesDir>/<repoId>/<taskId>-<attemptId>`，分支 `joy/<taskId>/<attemptId>`；id 只允許安全字元         | id 會進路徑與分支名，擋掉 `..` 與分隔符                                                   |
| 2026-11-03 | diff 一律對 `baseCommit`，先 `git add --all`                                                                             | agent 可能自己 commit，也可能留下未追蹤檔；兩種都要算進去                                 |
| 2026-11-03 | `session_started` 一定是第一個事件：Claude 在 init 前送的事件先暫存                                                      | 真實 fixture 裡 `active_goal`、`autocompact_state` 在 init 之前                           |
| 2026-11-03 | Claude 不傳 `--include-partial-messages`，`stream_event` 一律丟棄                                                        | 一次任務 170+ 個逐字事件，存進 DB 沒有價值；UI 串流之後再評估                             |
| 2026-11-03 | 沒有 approvalTool 時一律加 `--permission-prompts none`                                                                   | headless 沒人回答，寧可拒絕也不要卡住                                                     |
| 2026-11-03 | SQLite 用 Node 內建的 `node:sqlite`，Node 需 ≥ 22.13                                                                     | 不用編譯原生模組，Windows 安裝最省事；介面集中在 `packages/db`，必要時可換 better-sqlite3 |
| 2026-11-03 | Codex 在 P1 用 `codex exec --json`；P2 評估改 `app-server`                                                               | 只有 app-server 有互動式審核與額度資訊。`docs/spikes/codex.md`                            |
| 2026-11-03 | Claude 用 `--permission-prompt-tool` 把審核交給 Joy 的 MCP 工具                                                          | 實測可行，`rm` 被成功攔下。`docs/spikes/claude-code.md`                                   |
| 2026-11-03 | Claude 用 `--session-id` 由 Joy 指定 id                                                                                  | 第一次呼叫就知道 id，當機後也能恢復                                                       |
| 2026-11-03 | 認不得的 CLI 事件轉成 `raw`，不丟錯                                                                                      | 實測就看到文件沒寫的事件種類                                                              |
| 2026-11-03 | 授權 BSL 1.1，4 年後轉 Apache-2.0                                                                                        | 保留商業化空間；接受外部 PR 前需 CLA                                                      |
| 2026-11-03 | TypeScript 鎖 6.0                                                                                                        | typescript-eslint 尚未支援 7                                                              |
| 2026-11-03 | 狀態放 repo 的 `docs/STATUS.md`，不放 Obsidian                                                                           | agent 只讀得到 repo；Obsidian 可直接開 `docs/` 當 vault                                   |

## 已知的坑

- `claude -p` 要關閉 stdin，否則會等 3 秒。
- prompt 一定放在 `--` 之後，不然以 `-` 開頭的 prompt 會被當成旗標。
- 真實 CLI 的端到端測試：`JOY_E2E_CLAUDE=1 pnpm vitest run --project providers provider.e2e`（會用掉一點額度）。
- Codex 沒網路時會無限重試，不會自己結束：adapter 一定要有逾時。
- Codex 的 `error` 事件常常只是「重新連線中」，不能一律當失敗。
- Claude 的 MCP 工具呼叫也會送去審核：Joy 自己的工具要預設放行。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
- 這個專案的雲端 session 曾出現 `cd <repo> && git ...` 回報「not a git repository」；改用 `git -C <repo>` 可避開。
- Windows 的 git 預設 `core.autocrlf=true`：測試裡比對檔案內容前要在測試 repo 關掉它。
- 新套件要跑 `pnpm install` 才會出現在 workspace；`vitest.config.ts` 的 project 名稱用套件名。
