# @joy/core

Joy 所有套件共用的型別與介面。沒有 I/O、沒有相依套件。**修改這裡需要人工審核**（見 `AGENTS.md`）。

| 檔案          | 內容                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `provider.ts` | `ProviderKind`、`ModelRef`、`AgentEvent`、`RunOptions`、`AgentProvider` |
| `roles.ts`    | 六個角色與每個任務的覆寫規則                                            |
| `task.ts`     | 任務、嘗試（attempt）、狀態、結構化 review 結果                         |
| `executor.ts` | worktree 執行環境                                                       |
| `policy.ts`   | 權限等級（🟢🟡🔴）、動作種類、請求來源                                  |
| `channel.ts`  | Web / Telegram / LINE 的共同介面                                        |

## AgentEvent

每個 provider 都要把上游事件轉成下面這些。來源見 `docs/spikes/`。

| `type`              | 什麼時候發出                                 | Claude Code 來源                     | Codex 來源                                                    |
| ------------------- | -------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `session_started`   | 第一個事件；帶 `sessionId`（之後 resume 用） | `system/init`                        | `thread.started`                                              |
| `status`            | 進度文字，給 UI 的「正在做什麼」             | `system/task_summary`                | `turn.started`、`todo_list`                                   |
| `message`           | 模型對使用者說的話                           | `assistant` 的 `text`                | `agent_message`                                               |
| `thinking`          | 推理內容                                     | `assistant` 的 `thinking`            | `reasoning`                                                   |
| `tool_call`         | 模型呼叫工具（含 shell 指令、MCP）           | `assistant` 的 `tool_use`            | `command_execution`、`mcp_tool_call`、`web_search`（started） |
| `tool_result`       | 工具結果；`isError` 表示失敗或被拒           | `user` 的 `tool_result`              | 上述 item 的 completed                                        |
| `file_change`       | 檔案被新增、修改、刪除                       | 從 `Edit` / `Write` 的 tool_use 推得 | `file_change`                                                 |
| `permission_denied` | 動作被權限機制拒絕                           | `system/permission_denied`           | （exec 模式沒有）                                             |
| `quota`             | 訂閱額度狀態                                 | `rate_limit_event`                   | （exec 模式沒有；app-server 的 `account/rateLimits/updated`） |
| `usage`             | token 與等值花費                             | `result.usage`、`total_cost_usd`     | `turn.completed.usage`                                        |
| `error`             | 錯誤；`recoverable` 為真時只是通知           | `result.is_error`                    | `error`（常是重新連線）、`turn.failed`（不可恢復）            |
| `done`              | **一定是最後一個事件，而且只有一個**         | `result`                             | `turn.completed` / `turn.failed`                              |
| `raw`               | 認不得的上游事件，原文保留，**不可丟出錯誤** | 例如 `active_goal`、`stream_event`   | 新增的 item 種類                                              |

## 規則

- `run()` 結束前一定發出恰好一個 `done`；行程無法啟動時才 throw。
- 型別裡的 `ModelRef.model` 是設定值（`opus`、`gpt-5-codex`…），程式邏輯不可寫死。
- `RunOptions.approvalTool` 只有 `capabilities.delegatedApproval` 為真的 provider 會用；其餘靠 `autonomy` 限制。
