# Joy 目前狀態

> 開工前先讀本檔、`AGENTS.md`、`docs/PLAN.md`；收工前更新本檔。這裡記錄最新進度、阻塞、下一步與最近決策。

- 最後更新：2026-11-04
- T3.6：`t3.6-event-memory` 以 PR #14 的 `t3.3-memory` head `9d9f350cf1c8d97c6960aad25adbba28e3576155` 為基礎；摘要只接受明確使用者核准，檢索沿用 `memories_fts`。`messages` 僅有 role/content/conversation/time，不能證明來源，因此不自動彙整舊對話；embedding 延後。
- 目前階段：**P2 尚有待決項；P3 T3.3 PR #14 與 T3.6 PR #18 均為 draft，需 owner review；T3.4 記憶管理 slice 已完成，回答引用仍 blocked**。T3.6 本地 `pnpm check` 通過；PR #18 的 macOS、Ubuntu、Windows checks 於最近查詢仍在進行。舊 PR #8–#12 狀態沿用下方記錄。
- T3.3 parent：PR #14 `t3.3-memory` head=`9d9f350cf1c8d97c6960aad25adbba28e3576155`、base=`t2.2-tools`。T3.6 branch `t3.6-event-memory` head=`d4df4091516153ab7ed7fa554231b382770759cb`；既有 PR #18 base=`t3.3-memory`（draft），本 ticket 不修改。T3.4 新分支 `t3.4-memory-ui` 以該 T3.6 head 為 base。
- T3.4 管理 UI slice：透過 public memory APIs/server endpoints 檢視、編輯及刪除 active non-sensitive 記憶；編輯保留 source/scope provenance，變更與刪除需明確使用者動作。Answer-level citations 未實作：資料庫沒有 per-answer memory-reference 欄位，且沒有 production chat route/UI；不新增推測的聊天路由或引用契約。T3.4 保持未勾選，待該依賴存在後完成。
- 本次 base sync 後驗證：隔離繼承 Git 身分的 `pnpm check` 通過（188 passed、2 skipped）；T2.2/T2.1 fake-provider Playwright E2E 通過（4 specs）。所有 provider 測試只使用 fakes，沒有呼叫真模型。

## 分支與 PR

```
main … t1.5-review-loop
  └─ #6 t1.6-server（已合併到相依分支）
      └─ #7 t1.7-event-log（已合併到相依分支）
          └─ #8 t1.9-github-pr（draft；base=t1.7-event-log）
              └─ #9 t1.8-web（draft；base=t1.9-github-pr）
                  └─ #10 t2.1-compete（draft；base=t1.8-web；head=`65a026c`）
                      └─ #11 t2.2-tools（draft；base=t2.1-compete）
                          ├─ #12 T3.9 model stats/UI（draft；base=t2.2-tools）
                          └─ t3.3-memory T3.3 memory（draft；base=t2.2-tools；owner review required）
                              └─ #18 T3.6 event memory（draft；base=t3.3-memory）
                                  └─ t3.4-memory-ui T3.4 memory management（draft；base=t3.6-event-memory；citations blocked）
```

- #6/#7 已合併到相依分支，不代表已合入 `main` 或已部署。
- #2–#5 仍 open、非 draft；三平台 checks 全綠。
- #8 三平台 checks 全綠；本分支不重跑其 macOS job。
- #9 三平台 checks 全綠，secrets handling 仍須 owner human review；不在本分支更動其審核狀態。
- #10 head=`65a026c` 三平台 checks 全綠，仍為 draft。#11 已在本地解決與新 base 的衝突並通過檢查；push 後確認新 head CI。舊 head `29229e8` 的綠色結果不驗證更新後程式碼。#12 head=`fc0439c` 三平台 checks 全綠，仍為 draft。

## 現在的樣子

| 部分                            | 狀態                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo / CI                   | pnpm、TypeScript strict、ESLint、Prettier、Vitest；三平台 CI 執行 `pnpm check`。                                                                                                                                          |
| `packages/core` / `packages/db` | 領域介面、SQLite schema、task/repo CRUD、事件/reviews/usage 持久化已完成。                                                                                                                                                |
| `packages/tools`                | T2.2 Tool Hub 提供 task-scoped MCP：唯讀 `ask_peer`、`task_status`、持久化 `request_approval`（僅記錄提案，不執行動作）。                                                                                                 |
| `packages/memory`               | T3.3 三層 memory storage 沿用既有 schema；T3.4 提供 active non-sensitive 記憶管理 CRUD，編輯與刪除需明確使用者動作；T3.6 明確核准後才寫入 episode summary並透過既有 FTS5 搜尋。因 `messages` 無來源欄位，不自動摘要訊息。 |
| `packages/providers`            | Claude CLI、Codex CLI、OpenAI API adapters 完成；Codex 目前仍使用合成 fixture，尚待登入電腦錄製真實 fixture。                                                                                                             |
| `packages/executor`             | 每個 attempt 使用獨立 Git worktree/branch，提供 diff、commit、cleanup。                                                                                                                                                   |
| `packages/orchestrator`         | T1.5 `reviewLoop()` 完成；T2.1 支援並行競賽、自動 strengths 合成、24,000-byte provider prompt 上限與 code-edit capability 驗證；provider 呼叫可注入 task-scoped MCP Tool Hub。                                            |
| server / UI / GitHub            | T2.1 server 支援合成候選持久化與選取、競爭互斥、重啟恢復和異常收尾；UI 可檢視並選取候選。T2.2 server 暴露 loopback、token-scoped stateless MCP endpoint，並持久化 approval 狀態供 task status 查詢。                      |

## 卡住 / 需要人做的事

1. **T1.8 draft PR #9**（[PR #9](https://github.com/jimmynycuee/Joy/pull/9)）：三平台 CI 全綠；secrets handling 仍需 owner human review。
2. **T2.1 draft PR #10**（[PR #10](https://github.com/jimmynycuee/Joy/pull/10)）：獨立審查修正已合入，head `65a026c` 三平台 CI 全綠；維持 draft、不合併。
3. **T2.2 draft PR #11**（[PR #11](https://github.com/jimmynycuee/Joy/pull/11)）：最新 `t2.1-compete` base 已合入，衝突已解決；完整本地檢查及 E2E 通過，更新後 head CI 待確認。維持 draft、不合併。
4. **T2.3 policy**：動作對應權限等級屬安全政策，需 owner 決定後才能完成，不可臆測。
5. **T2.4 Telegram**：依賴 T2.3 審核路徑，且需 owner bot token 與 chat-id 綁定；目前尚未核實可用憑證或帳號。
6. **T2.5 quota**：調查未找到 Codex `exec --json` 可可靠辨識限額的結構化訊號；備援、排隊、預算與價格策略仍待決策，不可用模糊錯誤文字猜測。
7. **T2.6 GitHub Issue trigger**：需先決定 label/觸發語義、允許 repo/actor 與預設 task mode；production webhook 還需可達 HTTPS ingress 與簽章密鑰，尚未驗證 ingress。
8. **T3.7 scheduler**：需決定 timezone/DST、錯過執行、重疊/重試策略及定時 code-writing 是否須 approval，未先猜定。
9. **Codex 真實 fixture**：既有 fixture 是合成資料；需在已登入電腦錄製並重跑 provider contract test。確認模型名稱仍待帳號實測；Windows 實機尚未手動測過，只有 CI 證據。
10. #2–#5 三平台 CI 綠但仍 open；#6/#7 僅合併在相依分支，尚不能聲稱全鏈已進 `main` 或已部署。
11. **T3.6 draft PR #18**（[PR #18](https://github.com/jimmynycuee/Joy/pull/18)）：base=`t3.3-memory`；三平台 CI 進行中，維持 draft 等 owner review。
12. **T3.4 answer citations**：本 PR 僅交付管理 UI/API；每則回答的 memory references 因無 schema 欄位與 production assistant route/UI 而 blocked，不推測或新增聊天端點。管理 endpoint 的 memory edits/deletes 待 owner review。

## 下一步（依相依順序）

1. 推送 PR #11 的 base sync 修正並確認更新後 head 的三平台 CI；依要求不改成 ready、不合併。
2. 追蹤 #10 獨立 review 與 #9 owner human review；不重跑 #8 macOS，也不更改 #8/#9 審核狀態。
3. #12 T3.9 draft PR 的三平台 CI 已綠；同時只推進不依賴未決 tier/trigger/quota/scheduler 政策的工作。
4. T3.3 draft PR 等待 owner human review；memory-write rules 維持 draft，未合併。
5. Codex 真實 fixture、模型名稱確認與 Windows 實機驗證留待相應條件可用時處理。
6. PR #18 三平台 CI 尚在進行，維持 draft 等 owner review；自動摘要需待 messages schema/寫入端能提供可信來源 provenance，embedding 語意搜尋仍延後。
7. T3.4 管理 slice draft PR 待 owner review；answer citations 等待 production chat route 與 per-answer reference contract，屆時再完成並勾選 ticket。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                                                                                                                                                                     | 原因 / 出處                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 2026-11-04 | T3.4 先交付記憶管理 UI/API，僅管理 active non-sensitive rows；編輯與刪除需明確使用者動作並保留既有 source/scope。每則回答的 memory 引用待 production chat route 和 per-answer reference contract，不虛構端點或完成狀態。 | 現有資料庫無 per-answer memory-reference 欄位，assistant loop 無 production chat route/UI。            |
| 2026-11-04 | T3.6 僅允許明確 user-approved 摘要寫入既有 episode memory，沿用 `memories_fts`；不新增 schema、不啟用 embeddings。舊 `messages` role/content 無法證明 user 內容未混入外部來源，因此 fail closed，不自動摘要。            | T3.6 資料來源安全要求；避免把外部文字或模型輸出當成可信對話記憶。                                      |
| 2026-11-04 | T3.3 user-scope 記憶只從明確標記的直接 user utterance 擷取；Email 等外部來源不解析，credential-like / government-ID 內容不寫入，confidence 與 expiry 沿用既有欄位。                                                      | T3.3 ticket 與既有外部內容不可信規則；保留 owner 對 memory-write rules 的審核。                        |
| 2026-11-04 | 「合併優點」採自動 synthesis；使用配置的 Judge 模型在獨立 worktree 執行額外呼叫，輸出可檢視、可明確選取的新候選，原候選保留。                                                                                            | owner 回答自動合成；維持明確勝者選取與 worktree 隔離。                                                 |
| 2026-11-03 | T2.2 Tool Hub 使用 loopback、token-scoped stateless MCP；`ask_peer` 僅呼叫不同 provider 且以 read-only 運行，approval request 與 awaiting 狀態持久化，取消時 pending approval 轉為 expired。                             | provider 與 server 整合、schema/error/cancellation、重啟持久化及 fake-provider acceptance 均有測試。   |
| 2026-11-03 | T2.1 以 Implementer/Reviewer 不同 provider 作平行候選，各在獨立 worktree 執行；read-only Judge 結構化比較，使用者明確選勝並將 `winner_selected` 持久化。                                                                 | 後續 owner 選擇自動 synthesis，同時保留原候選與明確勝者選取。                                          |
| 2026-11-03 | T2.1 裁判失敗但有成功候選時仍可 review/select；preflight 失敗要持久化並以首個缺失角色 provider 標記 anchor；勝者選取在讀取 body 後重驗狀態；resume 用 run boundary 限定最新候選。                                        | 唯讀獨立審查發現兩項中度與一項低度問題，均以 regression tests 重現與修正。                             |
| 2026-11-03 | T1.8 UI 從 task details/WebSocket replay 使用結果 diff，不新增 diff GET route；OpenAI key API 僅回 `{ set, source }`，key 走 SecretStore/Redactor。                                                                      | `Executor.diff()` 會 `git add --all` 改 worktree index；fake-provider Playwright e2e 驗證 key 不回顯。 |
| 2026-11-03 | T1.9 GitHub 發布由 `packages/github` 負責；限定非預設 worktree branch，無 shell push，開 draft PR。                                                                                                                      | bare remote + 假 gh 測試；push 由明確 UI 動作觸發。                                                    |
| 2026-11-03 | T1.7 event log 採 task-wide 單調序號，Redactor 遮罩後才寫 DB；usage 按 UTC 日/provider 累加。                                                                                                                            | 多次 attempt 可連續回放，避免秘密落盤。                                                                |
| 2026-11-03 | T1.6 server 固定只綁 `127.0.0.1`；重啟中斷以 `failed` + `interrupted` event 記錄，恢復沿用 worktree 與 implementer session/model。                                                                                       | 維持本機邊界並保存恢復檢查點。                                                                         |
| 2026-11-03 | Judge/reviewer 使用結構化 JSON Schema；列出 blocker 卻 approve 視為不通過；reviewLoop 輪數用完仍未通過保留工作結果，且不自動清理 worktree。                                                                              | 交由人檢視結果後再決定是否交付或清理。                                                                 |
| 2026-11-03 | 真實模型測試使用最便宜模型與 low effort；Codex fixture 暫以合成 fixture，錄到真實 fixture 後重跑 contract test。                                                                                                         | 控制訂閱額度使用並保持 adapter 合約驗證。                                                              |

## 已知的坑

- `claude -p` 要關閉 stdin；prompt 放在 `--` 之後。
- Codex 沒網路時可能持續重試，adapter 必須有 timeout；Codex `error` 事件不一定表示失敗。
- Claude CLI 在 `session_started` 前可能送事件；adapter 會暫存，確保啟動事件仍先於後續事件。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
- Windows Git 預設 `core.autocrlf=true`；測試比對內容前需在臨時 repo 關閉。
- 新套件須 `pnpm install` 才會加入 workspace；Vitest project 名稱依套件設定。
- 雲端 checkout 內 git 命令宜直接於 checkout 執行，避免某些環境下 `cd <repo> && git ...` 的 cwd 問題。
