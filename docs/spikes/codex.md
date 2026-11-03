# Spike T0.4：Codex

- 測試日期：2026-11-03
- 版本：codex-cli 0.166.0、@openai/codex-sdk 0.166.0
- Fixture：`tests/fixtures/cli-events/codex/`
- 限制：測試環境連不到 OpenAI、也沒有登入，所以**沒有錄到成功執行的事件**。
  事件格式取自官方 SDK 的型別定義（SDK 本身就是解析 `codex exec --json` 的輸出），加上一份「連不上網路」的真實錄製。

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

## 待確認（要在使用者的 Mac 上做）

- [ ] 執行 `node scripts/record-fixtures.mjs codex`，錄下 edit / mcp / resume 的真實事件
- [ ] 確認 MCP 用 `-c` 注入在 `exec` 模式下可用
- [ ] Windows 原生是否可用；不行就走 WSL（T4.4）
- [ ] 確認可用的模型名稱，更新 PLAN §3.3
