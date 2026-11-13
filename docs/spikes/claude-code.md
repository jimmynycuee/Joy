# Spike T0.3：Claude Code headless

- 測試日期：2026-11-03
- 版本：Claude Code 2.1.317（Linux 雲端環境，非使用者訂閱帳號）
- Fixture：`tests/fixtures/cli-events/claude/`（以 `node scripts/record-fixtures.mjs claude` 重錄）

## 結論

**Claude Code 的 headless 模式完全滿足 Joy 的需求。** 改檔、注入 MCP 工具、把權限決定交給 Joy、指定 / 恢復 session、
額度資訊都已實測可用。`providers/claude-cli`（T1.1）照下面的方式實作。

## 呼叫方式

```
claude -p <prompt>
  --output-format stream-json --verbose     # 一行一個 JSON 事件（stdout）
  --model <alias|name>                      # 例 haiku / opus；名稱放設定檔
  --session-id <uuid>                       # Joy 自己產生 id，第一次呼叫就知道
  --resume <uuid>                           # 接續同一個 session（id 不變）
  --permission-mode <mode>                  # acceptEdits | manual | auto | dontAsk | plan | bypassPermissions
  --mcp-config <file> --strict-mcp-config   # 只載入 Joy 的 Tool Hub，不吃使用者其他 MCP 設定
  --permission-prompt-tool mcp__joy__approve --permission-prompts host   # 權限問題交給 Joy
  --max-budget-usd <n>                      # 成本保險絲（只對 API 計費有意義）
```

- **stdin 一定要關閉**（spawn 時 `stdio: ['ignore', 'pipe', 'pipe']`）。否則 CLI 會等 stdin 3 秒並印出警告。
- 多輪對話可以用 `--input-format stream-json` 保持行程常駐；MVP 先用「每輪一個行程 + `--resume`」，比較簡單也容易恢復。
- **2026-11-09 起，實作者的 run 用 streaming input 讓擁有者即時補充（steer）**：
  - 旗標（本機 `claude --help`，2.1.319 確認）：`--input-format stream-json`（只能配 `-p`）；另有 `--replay-user-messages`（Joy 沒用）。
  - stdin 一行一個 `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}`（Agent SDK streaming input 文件的訊息形狀）；prompt 是第一則，命令列不再有 `-- <prompt>`，stdin 要 `pipe`。
  - 官方文件（code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode）：streaming input 支援 queued messages、依序處理；範例在輸入結束後仍會回覆兩則訊息，Joy 據此在第一個 `result` 就關 stdin，之後的訊息由 server 排到下一輪。
  - **未驗證**：turn 進行中收到的訊息是插在工具呼叫之間，還是排成下一個 turn（只有第三方資料與 GitHub issue 提到 CLI 會在工具呼叫之間取用）；兩種情況 Joy 都能處理（多個 `result` 時 `done` 只發一次；第一個 `result` 決定成敗，之後輪次失敗只當 recoverable）。多輪時 `total_cost_usd`／`usage` 是否累計也未確認，Joy 只取最後一個 `result`、不相加。
  - 容器 repo 不用 streaming input（`docker run` 沒有 `-i`）；由 server 傳給 provider 的 `forwardsStdin(cwd)` 判斷。
  - 要錄的 fixture：一個 turn 進行中送第二則訊息、以及第一個 result 後才關 stdin 的完整輸出。

## 事件格式（stdout JSONL）

| `type` / `subtype`                                                                                          | 意義                                                                                                                           | 對應 `AgentEvent`                                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `system/init`                                                                                               | session_id、model、cwd、permissionMode、tools、mcp_servers（含連線狀態）、claude_code_version                                  | `session_started`                                           |
| `assistant`                                                                                                 | `message.content[]`：`text` / `thinking` / `tool_use{id,name,input}`                                                           | `message` / `thinking` / `tool_call`                        |
| `user`                                                                                                      | `message.content[]`：`tool_result{tool_use_id, content, is_error}`                                                             | `tool_result`                                               |
| `stream_event`                                                                                              | 逐字串流（`content_block_delta` 等），量很大                                                                                   | MVP 可忽略或轉成 `message_delta`                            |
| `rate_limit_event`                                                                                          | `rate_limit_info.status`、`unifiedWindows.five_hour/seven_day.utilization`、`resetsAt`                                         | `quota`                                                     |
| `system/permission_denied`                                                                                  | `tool_name`、`decision_reason`                                                                                                 | `tool_result`（isError）+ 記錄                              |
| `system/status`、`task_summary`、`post_turn_summary`、`thinking_tokens`、`active_goal`、`autocompact_state` | 進度與內部狀態                                                                                                                 | `status`（task_summary 很適合當 UI 的「正在做什麼」）或忽略 |
| `result`                                                                                                    | `subtype`（success / error_*）、`is_error`、`num_turns`、`result`（最後回覆）、`total_cost_usd`、`usage`、`permission_denials` | `usage` + `done`                                            |

**未知的 `type` 一律保留原文、轉成 `raw` 事件，不可丟出錯誤。** 這次就看到好幾種文件沒寫的事件（`active_goal`、`autocompact_state`）。

## 權限與審核

- `--permission-prompt-tool mcp__joy__approve --permission-prompts host`：需要審核時，CLI 呼叫 Joy 的 MCP 工具，參數為
  `{ tool_name, input, tool_use_id }`；工具回傳文字 JSON：
  - 允許：`{"behavior":"allow","updatedInput":<input>}`
  - 拒絕：`{"behavior":"deny","message":"..."}`
- 實測：`rm math.js` 被 stub 拒絕，模型收到拒絕原因後**沒有繞路**，並如實回報。
- 唯讀的指令（如 `git status`）不會問，CLI 自己放行。
- **MCP 工具本身也會被送去審核**（例如 `mcp__joy__ask_peer`）。T2.3 的 policy 要把 Joy 自己的工具預設放行。
- `acceptEdits` 模式下，未獲許可的動作會直接拒絕，並發出 `system/permission_denied` 事件。

## 額度感知（T2.5）

`rate_limit_event` 直接提供 5 小時與 7 天窗口的使用率與重置時間，**不必從錯誤訊息猜**。
撞到上限時的實際事件沒有錄到（未觸發），T2.5 要補一份 fixture。

## 成本

`result.total_cost_usd` 一定會有值。用訂閱時這是「等值 API 價格」的估算，不是實際扣款，只能用來比較，不要拿來計費。

## 待確認

- [ ] 在使用者的 Mac 上用訂閱帳號重錄一次（`init` 事件裡的 plugins / skills 會不同）
- [ ] 撞到額度上限時的事件（T2.5）
- [ ] Windows 原生：`claude` 是 `.cmd` 還是原生執行檔，影響 spawn 方式（T1.1）
- [ ] `--input-format stream-json` 下 turn 進行中送訊息的真實事件（steer，見上）
