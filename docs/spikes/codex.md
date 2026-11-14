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

## app-server：執行中補充（`turn/steer`，2026-11-09）

- 以本機 codex-cli 0.166.0 的 `codex app-server generate-json-schema` 確認：`turn/steer` 參數 `{threadId, expectedTurnId, input: UserInput[], clientUserMessageId?}`（前三者必填），回應 `{turnId}`；`expectedTurnId` 與目前進行中的 turn 不符就失敗。另有 `turn/interrupt`（Joy 沒用）。
- Joy 用 `turn/start` 回應裡的 `turn.id` 當 `expectedTurnId`，`turn/completed` 後就不再送。
- **未驗證**：真實 app-server 對 steer 的事件（是否另有通知、agent 何時讀到）；contract test 用的是合成的假 app-server。

## 附件：圖片（2026-11-14）

- 本機 codex-cli 0.166.0：`codex exec --help` 與 `codex exec resume --help` 都有 `-i, --image <FILE>...`（附在第一則／resume 後那則 prompt）。這個旗標吃多個值，Joy 每張圖各給一個 `--image`，並用 `--` 結束清單再放 prompt。
- `codex app-server generate-json-schema`：`UserInput` 有 `text`、`image`（`url` 或 `fileId`，可選 `detail`）、`localImage`（`path`，可選 `detail`）、`audio`／`localAudio`、`skill`、`mention`。Joy 在 `turn/start` 與 `turn/steer` 用 `{type:'localImage', path}`，路徑是 `<JOY_HOME>/attachments/<id>`（worktree 外）。
- app-server 完成的 `userMessage` item 是 Joy 自己輸入的回聲（可能含引用進 prompt 的文字檔），parser 現在直接丟掉，不記成 `raw` 事件。
- 容器模式（只有 `exec`）：provider 用 wrapper 的 `readFiles` 明確列出 `--image` 的路徑，容器以唯讀方式掛進來（同路徑）。附件檔名是 `<uuid>.<ext>`，副檔名依嗅探到的型別，給依副檔名判斷的工具用。
- 長 prompt：`codex exec --help` 寫「If not provided as an argument (or if `-` is used), instructions are read from stdin」，`codex exec resume --help` 寫「If `-` is used, read from stdin」。prompt 超過 16 KB 時，Joy 用 `-` 並把 prompt 寫進 stdin；沒有 stdin 的容器 run 超過 100 KB 時報錯。
- **未驗證**：app-server 是否自己讀 `localImage` 檔（推測是，因為 Joy 沒送內容）、sandbox 外的路徑是否可讀、`exec --image` 在容器裡是否可用；要錄 fixture。官方文件這次沒有另外查（schema 與 `--help` 已足夠決定做法）。

## 待確認（要在使用者的 Mac 上做）

- [ ] 執行 `node scripts/record-fixtures.mjs codex`，錄下 edit / mcp / resume 的真實事件
- [ ] 確認 MCP 用 `-c` 注入在 `exec` 模式下可用
- [ ] Windows 原生是否可用；不行就走 WSL（T4.4）
- [ ] 確認可用的模型名稱，更新 PLAN §3.3
- [ ] 錄一次 app-server 的 `turn/steer`（turn 進行中送補充訊息）
