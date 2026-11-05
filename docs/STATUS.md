# Joy 目前狀態

> 開工前先讀本檔、`AGENTS.md`、`docs/PLAN.md`；收工前更新本檔。這裡記錄最新進度、阻塞、下一步與最近決策。

- 最後更新：2026-11-05
- **T4.3 PR #20 conflict follow-up**：已將最新 `t1.8-web`（`dcb91534`）合併至 `t4.3-desktop`，保留 base 的 PR #9 更新並解決 `docs/STATUS.md` 衝突；合併提交已發布至 PR #20（head `64fe3776`），PR 維持 draft，GitHub checks 執行中。
- T1.8／PR #9 follow-up：SecretStore/API 現在拒絕短於 Redactor 最低長度的值與舊短值；provider 切換會更新預設建議模型並保留自訂模型；WebSocket 初始事件改為緩衝後合併，避免逐事件重排，序號計算支援大型回放。
- PR #9 仍保持 draft，secrets handling 的 owner review 仍待完成。#9 目前仍需等 PR #8 的修補已驗證並發布新 head 後才能對齊 base；此工作尚未對舊 #8 head rebase。此次本地 `pnpm check`（189 tests passed、2 skipped）、8 個 Playwright E2E specs、web build 與 `git diff --check` 通過；新 head 的 GitHub CI 尚未驗證。
- 目前階段：**P2 進行中**。T2.1 自動 strengths 合成及獨立審查提出的重啟恢復、競爭、prompt 容量、錯誤收尾與 provider capability 缺陷已修正並在本地驗證；PR #10 仍 draft。T2.2 draft PR #11（head `29229e8`）與 T3.9 draft PR #12（head `fc0439c`）三平台 CI 全綠。GitHub 上 #2–#5 仍 open、非 draft 且三平台 CI 全綠；#6/#7 merged 到相依分支而非 `main`；#8/#9 三平台 CI 全綠且仍 draft，#9 secrets handling 必須先由 owner human review。依目前指示所有 PR 保持 draft、不合併。
- 工作分支：`t2.1-compete`，基於 `t1.8-web` commit `a852b60`；目前包含 T2.1 引擎、server/UI、審查修正與自動合成候選實作，PR #10 為 draft。
- 本地驗證：`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL pnpm check` 通過（181 tests passed、2 skipped）；T2.1 Playwright E2E 通過（3 specs），orchestrator/server 定向測試 44/44 通過。所有互動測試使用 fake providers，沒有呼叫真模型。一般環境的 `pnpm check` 有一項既有 fallback-identity 測試受繼承 Git 身分影響，已另開 issue #13。

## 分支與 PR

```
main … t1.5-review-loop
  └─ #6 t1.6-server（已合併到依賴分支）
      └─ #7 t1.7-event-log（已合併到依賴分支）
          └─ #8 t1.9-github-pr（draft；base=t1.7-event-log）
              └─ #9 t1.8-web（draft；base=t1.9-github-pr）
                  └─ #10 t2.1-compete（draft；base=t1.8-web）
                      └─ #11 t2.2-tools（draft；base=t2.1-compete）
                          └─ #12 T3.9 model stats/UI（draft；base=t2.2-tools）
```

- 已 live 核實 #6/#7 為 merged，三平台 checks 成功；#7 的 base 是 `t1.6-server`，不能據此聲稱已在 `main` 經 CI 或已部署。
- #2–#5 目前仍 open、非 draft；各自 Ubuntu、macOS、Windows checks 成功，尚未合併。
- #9 的 Ubuntu、macOS、Windows checks 全綠，但 secrets 變更須 owner human review；未見 GitHub review 留言。
- #8 的 Ubuntu、macOS、Windows checks 現已全綠；先前 macOS runner 取消已由後續成功結果解決，PR 仍 draft。
- #10 前一個已發布 head `9fa9ca9` 的 Ubuntu、macOS、Windows checks 全綠；之後的獨立審查修正已在本地驗證，PR 仍 draft，GitHub 尚無 review。#11 head `29229e8`、#12 head `fc0439c` 的三平台 checks 全綠，兩者皆為 draft。

## 現在的樣子

| 部分                            | 狀態                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo / CI                   | pnpm、TypeScript strict、ESLint、Prettier、Vitest；三平台 CI 執行 `pnpm check`。                                                              |
| `packages/core` / `packages/db` | 領域介面、SQLite schema、task/repo CRUD、事件/reviews/usage 持久化已完成。                                                                    |
| `packages/providers`            | Claude CLI、Codex CLI、OpenAI API adapters 完成；Codex 目前仍使用合成 fixture，尚待登入電腦錄製真實 fixture。                                 |
| `packages/executor`             | 每個 attempt 使用獨立 Git worktree/branch，提供 diff、commit、cleanup。                                                                       |
| `packages/orchestrator`         | T1.5 `reviewLoop()` 完成；T2.1 支援並行競賽、自動 strengths 合成、24,000-byte provider prompt 上限，以及 code-edit capability 驗證。          |
| server / UI / GitHub            | T2.1 server 支援合成成功候選的事件持久化與選取、競爭互斥、重啟恢復和異常收尾；UI 將合成候選置頂、顯示 diff 並可選取；fake-provider E2E 通過。 |

## 卡住 / 需要人做的事

1. **T1.8 draft PR #9**（[PR #9](https://github.com/jimmynycuee/Joy/pull/9)）：三平台 CI 全綠；secrets handling 仍需 owner human review。
2. **T2.1 draft PR #10**（[PR #10](https://github.com/jimmynycuee/Joy/pull/10)）：獨立審查的五項發現已修正；定向測試、完整 `pnpm check`（隔離繼承 Git 身分）與 Playwright E2E 通過。維持 draft、不合併，GitHub 尚無 review。
3. **T2.3 policy**：動作對應權限等級是安全政策，已送 owner 問題卡；答覆前不設定 tier、不啟用分類。
4. **T2.4 Telegram**：依賴 T2.3 審核路徑，且需 owner 的 bot token 與 chat-id 綁定；目前尚未核實可用的 Telegram 憑證或帳號。
5. **T2.5 quota**：調查未找到 Codex `exec --json` 可可靠辨識限額的結構化訊號；不可用模糊錯誤文字猜測。備援、排隊、預算與價格策略仍待決策。
6. **T2.6 GitHub Issue trigger**：要先決定 label/觸發語義、允許 repo/actor 與預設 task mode；production webhook 還需可達 HTTPS ingress 與簽章密鑰。伺服器目前只綁 loopback，未驗證任何 ingress。
7. **T3.7 scheduler**：需決定 timezone/DST、錯過執行、重疊/重試策略，以及定時 code-writing 是否須 approval，未先猜定。
8. **Codex 真實 fixture**：既有 fixture 是合成資料；Cloud Codex CLI 目前沒有登入；需有已登入 CLI session 後錄製並重跑 provider contract test。
9. 確認模型名稱仍待帳號實測；Windows 實機尚未手動測過，只有 CI 證據。
10. GitHub #2–#5 雖三平台 CI 綠仍 open；#6/#7 僅合併在相依分支，尚不能聲稱全鏈已進 `main` 或已部署。

## 下一步（依相依順序）

1. 保持 #10 draft/no-merge hold；新 head 的 checks 與 owner review 都未確認前，不改變 readiness 狀態。
2. #11 T2.2 與 #12 T3.9 已交付且 CI 綠；只推進不依賴未決 tier/trigger/quota/scheduler 政策的工作。
3. #9 等待 owner human review；#8 已全綠，不需重跑。持續核對 #2–#5 與相依 PR 狀態，不把 stack merge 說成進 `main`。
4. Codex 真實 fixture、模型名稱確認與 Windows 實機驗證留待相應條件可用時處理。

## 最近的決策（新的放最上面）

| 日期       | 決策                                                                                                                                                                              | 原因 / 出處                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-11-04 | 「合併優點」採自動 synthesis；使用配置的 Judge 模型在獨立 worktree 執行額外呼叫，輸出可檢視、可明確選取的新候選，原候選保留。                                                     | owner 回答自動合成；維持明確勝者選取與 worktree 隔離。                                                 |
| 2026-11-03 | T2.1 以 Implementer/Reviewer 不同 provider 作平行候選，各在獨立 worktree 執行；read-only Judge 結構化比較，使用者明確選勝並將 `winner_selected` 持久化。                          | 既有 API 沒有 synthesis/merge flow；是否增加模型呼叫、人工融合或延後已透過問題卡詢問。                 |
| 2026-11-03 | T2.1 裁判失敗但有成功候選時仍可 review/select；preflight 失敗要持久化並以首個缺失角色 provider 標記 anchor；勝者選取在讀取 body 後重驗狀態；resume 用 run boundary 限定最新候選。 | 唯讀獨立審查發現兩項中度與一項低度問題，均以 regression tests 重現與修正。                             |
| 2026-11-03 | T1.8 UI 從 task details/WebSocket replay 使用結果 diff，不新增 diff GET route；OpenAI key API 僅回 `{ set, source }`，key 走 SecretStore/Redactor。                               | `Executor.diff()` 會 `git add --all` 改 worktree index；fake-provider Playwright e2e 驗證 key 不回顯。 |
| 2026-11-03 | T1.9 GitHub 發布由 `packages/github` 負責；限定非預設 worktree branch，無 shell push，開 draft PR。                                                                               | bare remote + 假 gh 測試；push 由明確 UI 動作觸發。                                                    |
| 2026-11-03 | T1.7 event log 採 task-wide 單調序號，Redactor 遮罩後才寫 DB；usage 按 UTC 日/provider 累加。                                                                                     | 多次 attempt 可連續回放，避免秘密落盤。                                                                |
| 2026-11-03 | T1.6 server 固定只綁 `127.0.0.1`；重啟中斷以 `failed` + `interrupted` event 記錄，恢復沿用 worktree 與 implementer session/model。                                                | 維持本機邊界並保存恢復檢查點。                                                                         |
| 2026-11-03 | Judge/reviewer 使用結構化 JSON Schema；列出 blocker 卻 approve 視為不通過；reviewLoop 輪數用完仍未通過保留工作結果，且不自動清理 worktree。                                       | 交由人檢視結果後再決定是否交付或清理。                                                                 |
| 2026-11-03 | 真實模型測試使用最便宜模型與 low effort；Codex fixture 暫以合成 fixture，錄到真實 fixture 後重跑 contract test。                                                                  | 控制訂閱額度使用並保持 adapter 合約驗證。                                                              |

## 已知的坑

- `claude -p` 要關閉 stdin；prompt 放在 `--` 之後。
- Codex 沒網路時可能持續重試，adapter 必須有 timeout；Codex `error` 事件不一定表示失敗。
- Claude CLI 在 `session_started` 前可能送事件；adapter 會暫存，確保啟動事件仍先於後續事件。
- `node:sqlite` 在 Node 22 會印 ExperimentalWarning，無害。
- Windows Git 預設 `core.autocrlf=true`；測試比對內容前需在臨時 repo 關閉。
- 新套件須 `pnpm install` 才會加入 workspace；Vitest project 名稱依套件設定。
- 雲端 checkout 內 git 命令宜直接於 checkout 執行，避免某些環境下 `cd <repo> && git ...` 的 cwd 問題。
