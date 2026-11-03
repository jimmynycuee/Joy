# Joy 目前狀態

> 開工前先讀本檔、`AGENTS.md`、`docs/PLAN.md`；收工前更新本檔。這裡記錄最新進度、阻塞、下一步與最近決策。

- 最後更新：2026-11-03
- 目前階段：**T2.1 進行中**。T1.6/#6、T1.7/#7 已合併到相依分支；T1.9/#8 的 Ubuntu/Windows 成功、macOS job 因 runner 容量連續第三次取消（無測試步驟或 log，禁止重跑，等 owner 決定稍後是否再試）；T1.8/#9 三平台 CI 全綠但 secrets handling 必須先由 owner human review。T2.1/#10 已開 draft，base=`t1.8-web`，最新 head 的 CI 待跑。依目前 steering 所有 PR 保持 draft、不合併。
- 工作分支：`t2.1-compete`，基於 `t1.8-web` commit `a852b60`；已提交 T2.1 引擎、server/UI 整合與審查修正，PR #10 為 draft。
- 本地驗證：完整 `pnpm check` 通過（167 tests passed、2 skipped）；T1.8 與 T2.1 fake-provider Playwright spec 共 3 個通過，web production build 通過。沒有呼叫真模型。

## 分支與 PR

```
main … t1.5-review-loop
  └─ #6 t1.6-server（已合併到依賴分支）
      └─ #7 t1.7-event-log（已合併到依賴分支）
          └─ #8 t1.9-github-pr（draft；base=t1.7-event-log）
              └─ #9 t1.8-web（draft；base=t1.9-github-pr）
                  └─ #10 t2.1-compete（draft；base=t1.8-web）
```

- 已 live 核實 #6/#7 為 merged，三平台 checks 成功；#7 的 base 是 `t1.6-server`，不能據此聲稱已在 `main` 經 CI 或已部署。
- #9 的 Ubuntu、macOS、Windows checks 全綠，但 secrets 變更須 owner human review；總控 Session 正跟進依賴 PR，不在本分支重複操作。
- #8 的 Ubuntu/Windows 成功；macOS job 連續第三次在 runner 啟動前因容量問題取消，沒有測試失敗證據。依最新指示不重跑，等 owner 決定稍後是否再試。
- #10 本地驗證全通過；新 head 推送後 CI 待跑。依目前 steering，所有 PR 保持 draft、不合併；必要審核仍不可略過。

## 現在的樣子

| 部分                            | 狀態                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo / CI                   | pnpm、TypeScript strict、ESLint、Prettier、Vitest；三平台 CI 執行 `pnpm check`。                                                                                                                                 |
| `packages/core` / `packages/db` | 領域介面、SQLite schema、task/repo CRUD、事件/reviews/usage 持久化已完成。                                                                                                                                       |
| `packages/providers`            | Claude CLI、Codex CLI、OpenAI API adapters 完成；Codex 目前仍使用合成 fixture，尚待登入電腦錄製真實 fixture。                                                                                                    |
| `packages/executor`             | 每個 attempt 使用獨立 Git worktree/branch，提供 diff、commit、cleanup。                                                                                                                                          |
| `packages/orchestrator`         | T1.5 `reviewLoop()` 完成；T2.1 `compete()` 有平行候選、各自 worktree、部分成功保留、只讀結構化裁判與錯誤/取消處理。                                                                                              |
| server / UI / GitHub            | T1.6–T1.9 實作完成。T2.1 server API 已接上 compete、事件與結果持久化、明確勝者選取及 latest-run 選擇限制；UI 並排顯示候選 diff、模型/狀態及裁判理由，resume 以 run boundary 隔離舊候選，fake-provider E2E 通過。 |

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
3. T2.2 Tool Hub 與 T2.1 選擇無關，可從 `t2.1-compete` 繼續並開 stacked draft PR；之後依 `docs/PLAN.md` 接續 T2.3–T2.6，獨立票最多三個 child。
4. #8 macOS 不重跑、等待 owner 決定；#9 必須 owner human review。PR #8/#9 依賴/審核由總控負責。
5. Codex 真實 fixture、模型名稱確認與 Windows 實機驗證留待相應條件可用時處理。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                                                                                                                               | 原因 / 出處                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-11-03 | T2.1 以 Implementer/Reviewer 不同 provider 作平行候選，各在獨立 worktree 執行；read-only Judge 結構化比較，使用者明確選勝並將 `winner_selected` 持久化。「合併優點」仍待產品決定。 | 既有 API 沒有 synthesis/merge flow；是否增加模型呼叫、人工融合或延後已透過問題卡詢問。                 |
| 2026-11-03 | T2.1 裁判失敗但有成功候選時仍可 review/select；preflight 失敗要持久化並以首個缺失角色 provider 標記 anchor；勝者選取在讀取 body 後重驗狀態；resume 用 run boundary 限定最新候選。  | 唯讀獨立審查發現兩項中度與一項低度問題，均以 regression tests 重現與修正。                             |
| 2026-11-03 | T1.8 UI 從 task details/WebSocket replay 使用結果 diff，不新增 diff GET route；OpenAI key API 僅回 `{ set, source }`，key 走 SecretStore/Redactor。                                | `Executor.diff()` 會 `git add --all` 改 worktree index；fake-provider Playwright e2e 驗證 key 不回顯。 |
| 2026-11-03 | T1.9 GitHub 發布由 `packages/github` 負責；限定非預設 worktree branch，無 shell push，開 draft PR。                                                                                | bare remote + 假 gh 測試；push 由明確 UI 動作觸發。                                                    |
| 2026-11-03 | T1.7 event log 採 task-wide 單調序號，Redactor 遮罩後才寫 DB；usage 按 UTC 日/provider 累加。                                                                                      | 多次 attempt 可連續回放，避免秘密落盤。                                                                |
| 2026-11-03 | T1.6 server 固定只綁 `127.0.0.1`；重啟中斷以 `failed` + `interrupted` event 記錄，恢復沿用 worktree 與 implementer session/model。                                                 | 維持本機邊界並保存恢復檢查點。                                                                         |
| 2026-11-03 | Judge/reviewer 使用結構化 JSON Schema；列出 blocker 卻 approve 視為不通過；reviewLoop 輪數用完仍未通過保留工作結果，且不自動清理 worktree。                                        | 交由人檢視結果後再決定是否交付或清理。                                                                 |
| 2026-11-03 | 真實模型測試使用最便宜模型與 low effort；Codex fixture 暫以合成 fixture，錄到真實 fixture 後重跑 contract test。                                                                   | 控制訂閱額度使用並保持 adapter 合約驗證。                                                              |

## 已知的坑

- `claude -p` 要關閉 stdin；prompt 放在 `--` 之後。
- Codex 沒網路時可能持續重試，adapter 必須有 timeout；Codex `error` 事件不一定表示失敗。
- Claude CLI 在 `session_started` 前可能送事件；adapter 會暫存，確保啟動事件仍先於後續事件。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
- Windows Git 預設 `core.autocrlf=true`；測試比對內容前需在臨時 repo 關閉。
- 新套件須 `pnpm install` 才會加入 workspace；Vitest project 名稱依套件設定。
- 雲端 checkout 內 git 命令宜直接於 checkout 執行，避免某些環境下 `cd <repo> && git ...` 的 cwd 問題。
