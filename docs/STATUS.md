# Joy 目前狀態

> 開工前先讀本檔、`AGENTS.md`、`docs/PLAN.md`；收工前更新本檔。這裡記錄最新進度、阻塞、下一步與最近決策。

- 最後更新：2026-11-03
- 目前階段：**T2.1 進行中**。T1.6/#6、T1.7/#7 已合併到相依分支；T1.9/#8 與 T1.8/#9 三平台 CI 全綠，仍為 draft。#9 涉及 secrets handling，必須先由 owner human review。
- 工作分支：`t2.1-compete`，基於 `t1.8-web` commit `a852b60`；已提交引擎 milestone `7a7a66b`，server/UI 整合與測試已完成但尚未提交、推送或開 PR。
- 本地驗證：完整 `pnpm check` 通過（163 tests passed、2 skipped）；T1.8 與 T2.1 fake-provider Playwright spec 共 2 個通過。沒有呼叫真模型。

## 分支與 PR

```
main … t1.5-review-loop
  └─ #6 t1.6-server（已合併到依賴分支）
      └─ #7 t1.7-event-log（已合併到依賴分支）
          └─ #8 t1.9-github-pr（draft；base=t1.7-event-log）
              └─ #9 t1.8-web（draft；base=t1.9-github-pr）
                  └─ t2.1-compete（本地分支；base=t1.8-web；PR 尚未建立）
```

- 已 live 核實 #6/#7 為 merged，三平台 checks 成功；#7 的 base 是 `t1.6-server`，不能據此聲稱已在 `main` 經 CI 或已部署。
- #8/#9 目前都是 draft，Ubuntu、macOS、Windows checks 全綠。#9 的 secrets 變更須 owner review；總控 Session 正跟進依賴 PR，不在本分支重複操作。
- 擁有者已授權合併符合保護規則的 PR；必須審核的變更、人為核准與 branch protections 仍不可略過。

## 現在的樣子

| 部分                            | 狀態                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo / CI                   | pnpm、TypeScript strict、ESLint、Prettier、Vitest；三平台 CI 執行 `pnpm check`。                                                                        |
| `packages/core` / `packages/db` | 領域介面、SQLite schema、task/repo CRUD、事件/reviews/usage 持久化已完成。                                                                              |
| `packages/providers`            | Claude CLI、Codex CLI、OpenAI API adapters 完成；Codex 目前仍使用合成 fixture，尚待登入電腦錄製真實 fixture。                                           |
| `packages/executor`             | 每個 attempt 使用獨立 Git worktree/branch，提供 diff、commit、cleanup。                                                                                 |
| `packages/orchestrator`         | T1.5 `reviewLoop()` 完成；T2.1 `compete()` 有平行候選、各自 worktree、部分成功保留、只讀結構化裁判與錯誤/取消處理。                                     |
| server / UI / GitHub            | T1.6–T1.9 實作完成。T2.1 server API 已接上 compete、事件與結果持久化、明確勝者選取；UI 並排顯示候選 diff、模型/狀態及裁判理由，fake-provider E2E 通過。 |

## 卡住 / 需要人做的事

1. **T2.1「合併優點」產品選擇**：已送問題卡，詢問自動綜合 patch（額外模型呼叫）、人工融合，或本票先只比較/選勝、融合另列後續 ticket。不依賴該選擇的文件、驗收與發版準備持續進行。
2. **T1.8 draft PR #9**（[PR #9](https://github.com/jimmynycuee/Joy/pull/9)）：三平台 CI 全綠；secrets handling 需 owner human review，完成前不能合併。
3. **T1.9 draft PR #8**（[PR #8](https://github.com/jimmynycuee/Joy/pull/8)）：base=`t1.7-event-log`，三平台 CI 全綠，仍 draft；由總控依 PR 相依順序處理。
4. **Codex 真實 fixture**：既有 fixture 是合成資料；額度允許後需在已登入電腦執行 `node scripts/record-fixtures.mjs codex`（gpt-6-luna、low effort），重跑 provider contract test 並移除 `synthetic-edit.*`。
5. **確認模型名稱**：`packages/config/src/schema.ts` 預設值取自 Codex 0.166 清單，仍待確認帳號可用。
6. Windows 實機尚未手動測過，只有 CI 證據；舊 PR #2–#5 的目前 review/merge 狀態須按依賴與保護規則再核實。

## 下一步（依相依順序）

1. 取得 T2.1「合併優點」決定；完成其相依實作與驗收，繼續只用 fake provider。
2. 更新 `docs/PLAN.md` / 本檔；提交整合變更、推送 `t2.1-compete`，以 `t1.8-web` 為 base 開 draft PR，等 CI 與審查。
3. T2.1 完成後依 `docs/PLAN.md` 接續 T2.2–T2.6；獨立項目可並行，最多三個 child。PR #8/#9 的依賴/owner review 仍由總控負責。
4. Codex 真實 fixture、模型名稱確認與 Windows 實機驗證留待相應條件可用時處理。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                                                                                                                               | 原因 / 出處                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-11-03 | T2.1 以 Implementer/Reviewer 不同 provider 作平行候選，各在獨立 worktree 執行；read-only Judge 結構化比較，使用者明確選勝並將 `winner_selected` 持久化。「合併優點」仍待產品決定。 | 既有 API 沒有 synthesis/merge flow；是否增加模型呼叫、人工融合或延後已透過問題卡詢問。                 |
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
