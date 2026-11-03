# Joy 目前狀態

> 開工前先讀本檔、`AGENTS.md`、`docs/PLAN.md`；收工前更新本檔。這裡記錄最新進度、阻塞、下一步與最近決策。

- 最後更新：2026-11-03
- 目前階段：**T2.2 已實作並通過本地驗證，準備開 stacked draft PR**。T1.6/#6、T1.7/#7 已合併到相依分支；T1.9/#8 的 macOS job 因 runner 容量第三次取消，依指示不重跑；T1.8/#9 的 secrets handling 仍須 owner human review。T2.1「合併優點」產品選擇仍待回答，T2.2 未碰該範圍。
- 工作分支：`t2.2-tools`，直接基於更新後的 `t2.1-compete` head `08b6cf2e024a86138f1ce66a69536e5017ad9f0d`；T2.2 draft PR 尚待建立，預定 base=`t2.1-compete`。
- 本地驗證：`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL pnpm check` 通過（174 passed、2 skipped）；DB/orchestrator/tools/server 6 projects 共 50 tests 通過；T1.8/T2.1 fake-provider Playwright specs 4 個通過。沒有呼叫真模型。

## 分支與 PR

```
main … t1.5-review-loop
  └─ #6 t1.6-server（已合併到依賴分支）
      └─ #7 t1.7-event-log（已合併到依賴分支）
          └─ #8 t1.9-github-pr（draft；base=t1.7-event-log）
              └─ #9 t1.8-web（draft；base=t1.9-github-pr）
                  └─ #10 t2.1-compete（draft；base=t1.8-web；head=`08b6cf2`）
                      └─ `t2.2-tools`（本地分支；draft PR 待開，base=`t2.1-compete`）
```

- 已 live 核實 #6/#7 為 merged，三平台 checks 成功；#7 的 base 是 `t1.6-server`，不能據此聲稱已在 `main` 經 CI 或已部署。
- #9 的 Ubuntu、macOS、Windows checks 全綠，但 secrets 變更須 owner human review；總控 Session 正跟進依賴 PR，不在本分支重複操作。
- #8 的 Ubuntu/Windows 成功；macOS job 連續第三次在 runner 啟動前因容量問題取消，沒有測試失敗證據。依最新指示不重跑，等 owner 決定稍後是否再試。
- #10 最新 head=`08b6cf2`；PR #10 仍為 draft，Ubuntu check 已通過、Windows 執行中、macOS 排隊。T2.2 本地驗證通過，stacked draft PR 尚待建立；不改動 PR #8/#9 的審核或 runner 狀態。

## 現在的樣子

| 部分                            | 狀態                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo / CI                   | pnpm、TypeScript strict、ESLint、Prettier、Vitest；三平台 CI 執行 `pnpm check`。                                                                                                   |
| `packages/core` / `packages/db` | 領域介面、SQLite schema、task/repo CRUD、事件/reviews/usage 持久化已完成。                                                                                                         |
| `packages/tools`                | T2.2 Tool Hub 提供 task-scoped MCP：唯讀 `ask_peer`、`task_status`、持久化 `request_approval`（僅記錄提案，不執行動作）。                                                          |
| `packages/providers`            | Claude CLI、Codex CLI、OpenAI API adapters 完成；Codex 目前仍使用合成 fixture，尚待登入電腦錄製真實 fixture。                                                                      |
| `packages/executor`             | 每個 attempt 使用獨立 Git worktree/branch，提供 diff、commit、cleanup。                                                                                                            |
| `packages/orchestrator`         | T1.5 `reviewLoop()` 完成；T2.1 `compete()` 有平行候選與只讀裁判；provider 呼叫可注入 task-scoped MCP Tool Hub。                                                                    |
| server / UI / GitHub            | T1.6–T1.9 實作完成。T2.1 compete/server/UI 與 latest-run 選擇限制完成；T2.2 server 暴露 loopback、token-scoped stateless MCP endpoint，並持久化 approval 狀態供 task status 查詢。 |

## 卡住 / 需要人做的事

1. **T2.1「合併優點」產品選擇**：已送問題卡，詢問自動綜合 patch（額外模型呼叫）、人工融合，或本票先只比較/選勝、融合另列後續 ticket。不依賴該選擇的工作持續進行。
2. **T1.8 draft PR #9**（[PR #9](https://github.com/jimmynycuee/Joy/pull/9)）：三平台 CI 全綠；secrets handling 需 owner human review。
3. **T1.9 draft PR #8**（[PR #8](https://github.com/jimmynycuee/Joy/pull/8)）：base=`t1.7-event-log`；Ubuntu/Windows 通過，macOS 因 runner 容量第三次取消。依指示不重跑，等 owner 決定稍後是否重試。
4. **T2.1 draft PR #10**（[PR #10](https://github.com/jimmynycuee/Joy/pull/10)）：本地完整檢查及 fake E2E 通過；最新 head 推送後等 CI 與審查。所有 PR 維持 draft、不合併。
5. **Codex 真實 fixture**：既有 fixture 是合成資料；額度允許後需在已登入電腦執行 `node scripts/record-fixtures.mjs codex`（gpt-6-luna、low effort），重跑 provider contract test 並移除 `synthetic-edit.*`。
6. **確認模型名稱**：`packages/config/src/schema.ts` 預設值取自 Codex 0.166 清單，仍待確認帳號可用。
7. Windows 實機尚未手動測過，只有 CI 證據；舊 PR #2–#5 的目前 review/merge 狀態須按依賴與保護規則再核實。

## 下一步（依相依順序）

1. 等待 T2.1「合併優點」選擇；只完成該選擇相依的實作，其餘工作繼續用 fake provider。
2. 推送 #10 的已驗證審查修正，讀取新 head CI 並處理 review；依目前 steering 保持 draft、不合併。
3. T2.2 與 T2.1「合併優點」選擇無關；目前實作與本地驗證完成，需建立 base=`t2.1-compete` 的 stacked draft PR；之後依 `docs/PLAN.md` 接續 T2.3–T2.6。
4. #8 macOS 不重跑、等待 owner 決定；#9 必須 owner human review。PR #8/#9 依賴/審核由總控負責。
5. Codex 真實 fixture、模型名稱確認與 Windows 實機驗證留待相應條件可用時處理。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                                                                                                                                         | 原因 / 出處                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-11-03 | T2.2 Tool Hub 使用 loopback、token-scoped stateless MCP；`ask_peer` 僅呼叫不同 provider 且以 read-only 運行，approval request 與 awaiting 狀態持久化，取消時 pending approval 轉為 expired。 | provider 與 server 整合、schema/error/cancellation、重啟持久化及 fake-provider acceptance 均有測試。   |
| 2026-11-03 | T2.1 以 Implementer/Reviewer 不同 provider 作平行候選，各在獨立 worktree 執行；read-only Judge 結構化比較，使用者明確選勝並將 `winner_selected` 持久化。「合併優點」仍待產品決定。           | 既有 API 沒有 synthesis/merge flow；是否增加模型呼叫、人工融合或延後已透過問題卡詢問。                 |
| 2026-11-03 | T2.1 裁判失敗但有成功候選時仍可 review/select；preflight 失敗要持久化並以首個缺失角色 provider 標記 anchor；勝者選取在讀取 body 後重驗狀態；resume 用 run boundary 限定最新候選。            | 唯讀獨立審查發現兩項中度與一項低度問題，均以 regression tests 重現與修正。                             |
| 2026-11-03 | T1.8 UI 從 task details/WebSocket replay 使用結果 diff，不新增 diff GET route；OpenAI key API 僅回 `{ set, source }`，key 走 SecretStore/Redactor。                                          | `Executor.diff()` 會 `git add --all` 改 worktree index；fake-provider Playwright e2e 驗證 key 不回顯。 |
| 2026-11-03 | T1.9 GitHub 發布由 `packages/github` 負責；限定非預設 worktree branch，無 shell push，開 draft PR。                                                                                          | bare remote + 假 gh 測試；push 由明確 UI 動作觸發。                                                    |
| 2026-11-03 | T1.7 event log 採 task-wide 單調序號，Redactor 遮罩後才寫 DB；usage 按 UTC 日/provider 累加。                                                                                                | 多次 attempt 可連續回放，避免秘密落盤。                                                                |
| 2026-11-03 | T1.6 server 固定只綁 `127.0.0.1`；重啟中斷以 `failed` + `interrupted` event 記錄，恢復沿用 worktree 與 implementer session/model。                                                           | 維持本機邊界並保存恢復檢查點。                                                                         |
| 2026-11-03 | Judge/reviewer 使用結構化 JSON Schema；列出 blocker 卻 approve 視為不通過；reviewLoop 輪數用完仍未通過保留工作結果，且不自動清理 worktree。                                                  | 交由人檢視結果後再決定是否交付或清理。                                                                 |
| 2026-11-03 | 真實模型測試使用最便宜模型與 low effort；Codex fixture 暫以合成 fixture，錄到真實 fixture 後重跑 contract test。                                                                             | 控制訂閱額度使用並保持 adapter 合約驗證。                                                              |

## 已知的坑

- `claude -p` 要關閉 stdin；prompt 放在 `--` 之後。
- Codex 沒網路時可能持續重試，adapter 必須有 timeout；Codex `error` 事件不一定表示失敗。
- Claude CLI 在 `session_started` 前可能送事件；adapter 會暫存，確保啟動事件仍先於後續事件。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
- Windows Git 預設 `core.autocrlf=true`；測試比對內容前需在臨時 repo 關閉。
- 新套件須 `pnpm install` 才會加入 workspace；Vitest project 名稱依套件設定。
- 雲端 checkout 內 git 命令宜直接於 checkout 執行，避免某些環境下 `cd <repo> && git ...` 的 cwd 問題。
