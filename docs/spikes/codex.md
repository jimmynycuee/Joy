# Spike T0.4：Codex

- 測試日期：2026-11-04（fixture metadata 使用 UTC）
- 版本：codex-cli 0.166.0、@openai/codex-sdk 0.166.0
- Fixture：`tests/fixtures/cli-events/codex/`
- 結果：於已登入 ChatGPT 的 macOS 帳戶執行核准的 `node scripts/record-fixtures.mjs codex`；`codex login status` 回報 `Logged in using ChatGPT`，版本為 `codex-cli 0.166.0`。Edit、MCP、resume-1、resume-2 四次執行皆以 exit code 0 完成：edit 修正暫存 repo 的 `add()`；MCP 確認 `-c` 注入、`ask_peer` 回應及 `git status --short` / `rm math.js`；resume-2 由 resume-1 的 thread 取回 `PELICAN`。未傳 `--model` 覆寫，錄製資料不能證明實際模型名稱或 effort。
- 隱私檢查：逐一檢視本次產生的四組 `.jsonl` / `.meta.json`，未見訂閱憑證或私人檔案內容；工作路徑、使用者、Node 路徑、本機設定鍵及 CLI thread ID 均以佔位字串脫敏；既有手工 `network-error` fixture 的 thread ID 也已替換成佔位字串。Codex 輸出的未識別設定警告只保留脫敏後的設定佔位字串。
- 測試：新增 `tests/fixtures/cli-events/codex/codex-fixtures.test.mjs`，驗證四組已錄製的 JSONL / metadata、成功完成、事件及脫敏；`pnpm test` 會執行這些 Node fixture contract tests。此 checkout 尚無 Codex adapter / provider suite，因此這不是 adapter mapping 測試；T1.2 仍須以 adapter 實際解析 fixtures。
- 限制：原生 Windows、有效模型名稱與 rate-limit 行為均未由此錄製驗證。現有 `network-error` fixture 僅記錄重連通知，不作 rate-limit 結論。

## 三種整合方式比較

|                  | `codex exec --json`                       | `@openai/codex-sdk`（TS）       | `codex app-server`（JSON-RPC）                                                               |
| ---------------- | ----------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| 本質             | 一次一輪，JSONL 輸出                      | 包裝 `exec --json` 的 TS 函式庫 | 常駐行程，雙向 JSON-RPC（VS Code 擴充套件用的協定）                                          |
| 穩定度           | 有文件、有官方型別                        | 官方                            | 標示 experimental，協定很大（約 760 個型別）                                                 |
| 恢復 session     | `codex exec resume <id> <prompt>`         | `resumeThread(id)`              | `thread/resume`                                                                              |
| 注入 MCP         | `-c mcp_servers.<name>.command=…`         | 同左（透過設定）                | 同左                                                                                         |
| **互動式審核**   | ❌ 只能事先設定 sandbox / approval policy | ❌ 同左                         | ✅ `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 由 client 回覆 |
| **額度資訊**     | ❌ 只有錯誤訊息                           | ❌                              | ✅ `account/rateLimits/read`、`account/rateLimits/updated`（`usedPercent`、`resetsAt`）      |
| Joy 自己控制行程 | ✅                                        | ✅                              | ✅                                                                                           |

## 決定

1. **P1（T1.2）用 `codex exec --json`**，自己 spawn、自己解析，型別照抄 SDK 的 `ThreadEvent`。
   不直接依賴 SDK，是為了和 Claude adapter 走同一套行程管理（取消、逾時、Windows）。
   以 `--sandbox workspace-write` 限制在 worktree 內；危險動作在 P1 本來就不開放。
2. **P2（T2.3、T2.5）評估改用 `app-server`**：互動式審核與額度資訊只有它有。介面已經抽象成 `AgentProvider`，換實作不影響其他套件。
   協定型別可以用 `codex app-server generate-ts --out <dir>` 產生。

## 呼叫方式

```
codex exec --json [-m <model>] --sandbox workspace-write <prompt>     # cwd = worktree
codex exec resume --json [-m <model>] <thread_id> <prompt>
-c 'mcp_servers.joy.command="node"' -c 'mcp_servers.joy.args=["/path/tool-hub.mjs"]'
```

其他有用的旗標：`--output-schema <file>`（讓最後回覆符合 JSON Schema，**review 結果的結構化輸出可以直接用**）、
`--ephemeral`（不存 session）、`--ignore-user-config`、`--skip-git-repo-check`、`-o <file>`（最後一則訊息寫入檔案）。
`codex exec review` 是內建的 code review 指令，T1.5 可以評估直接使用。

## 事件格式（stdout JSONL，取自 SDK 型別）

| `type`                                             | 內容                                                                                                         | 對應 `AgentEvent`                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `thread.started`                                   | `thread_id`                                                                                                  | `session_started`                                                                            |
| `turn.started`                                     | —                                                                                                            | `status`                                                                                     |
| `item.started` / `item.updated` / `item.completed` | `item`（見下表）                                                                                             | 依 item 種類                                                                                 |
| `turn.completed`                                   | `usage{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` | `usage` + `done`                                                                             |
| `turn.failed`                                      | `error.message`                                                                                              | `error`（不可恢復）                                                                          |
| `error`                                            | `message`                                                                                                    | **注意：可能只是重新連線通知**（實測 `Reconnecting... 2/5`），要依訊息判斷，不能一律視為失敗 |

| `item.type`         | 欄位                                                       | 對應                        |
| ------------------- | ---------------------------------------------------------- | --------------------------- |
| `agent_message`     | `text`                                                     | `message`                   |
| `reasoning`         | `text`                                                     | `thinking`                  |
| `command_execution` | `command`、`aggregated_output`、`exit_code`、`status`      | `tool_call` + `tool_result` |
| `file_change`       | `changes[{path, kind: add/delete/update}]`、`status`       | `file_change`               |
| `mcp_tool_call`     | `server`、`tool`、`arguments`、`result`、`error`、`status` | `tool_call` + `tool_result` |
| `web_search`        | `query`                                                    | `tool_call`                 |
| `todo_list`         | `items[{text, completed}]`                                 | `status`（UI 顯示計畫）     |
| `error`             | `message`                                                  | `error`（可恢復）           |

## 實測到的事

- 沒有網路時，Codex 會持續重試（WebSocket → HTTPS fallback → 等待網路），**不會自己結束**。adapter 一定要有逾時與取消。
- `error` 事件與 `item.completed` 裡的 `error` item 都出現了，兩者都不是致命錯誤。

## 待確認

- [x] 執行 `node scripts/record-fixtures.mjs codex`，錄下 edit / mcp / resume 的真實事件；四組 fixture 的 raw-stream contract test 已加入
- [x] 確認 MCP 用 `-c` 注入在 `exec` 模式下可用
- [ ] Windows 原生是否可用；不行就走 WSL（T4.4）
- [ ] 確認可用的模型名稱，更新 PLAN §3.3；本次未指定 `--model`，未證實實際模型
- [ ] rate-limit 行為：目前沒有測試證據，不作任何行為結論；現有 network-error fixture 只記錄重連通知。
