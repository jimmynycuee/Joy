# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-05
- 目前階段：P1 依指定順序收尾；完成後再進 P2、P3。

## 驗證結果

### main Windows CI publisher 測試

- main 的 Windows CI 重現 publisher 測試在 Vitest 預設 5 秒 timeout 中超時，隨後暫存 repo 清理回報 `EBUSY`。失敗測試建立兩個 fixture repo，需執行多個序列 Git 子程序。
- 對該測試設定 30 秒 timeout；遞迴刪除暫存目錄加入 10 次、每次 100 ms 的 busy/permission retry。
- 本機 Linux：`pnpm exec vitest run --project github packages/github/src/publisher.test.ts` 通過（17/17）；清除 runner 注入的 Git 身分後 `pnpm check` 通過（197 passed、2 skipped）。`git diff --check` 通過。
- Windows 實際行為需以 GitHub Actions 驗證；本機沒有 Windows 執行環境。

### T1.9 GitHub publisher

- 已把 T1.9 publisher 改動重放至最新 main；程式檢查推送／抓取目標與 base ancestry，逐一掃描將推送 commits 的敏感檔名、二進位變更、secret-like 新增內容、commit message；先批次查詢變更 blob 大小，只讀取不超過 1 KiB 的 blob 阻擋 Git LFS pointer（含只變更 oid／size 的更新），避免讀取大型文字 blob；重用既有 PR 時使用 `headRepositoryOwner.login` 與 `headRepository.name` 比對完整 repo identity，並遮罩 body。
- 獨立審查指出 fetch URL rewrite、Git LFS payload、PR head repo identity 與既有 body 遮罩風險，均已修正並新增回歸測試；後續複審補捉編輯 LFS pointer、較舊 gh JSON 欄位相容性、signed size／前置 extension、大型文字 blob 小修改，以及 Git LFS 的 U+0085 空白語意，均已補上修正與回歸測試。head `7aa7a66` 的獨立複審已 approve、無 blocker；其非阻塞建議的舊版 git-lfs alphanumeric／帶尾綴 OID 偵測與批次 stdin EPIPE 處理，已在本地 follow-up 加入，待新 head 發布後再做獨立複核。
- 本機 `env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 通過：Prettier、ESLint、workspace typecheck 均成功，269 tests passed、2 skipped；publisher 測試 50/50 通過。`git diff --check` 通過。
- PLAN 的真實驗收仍未完成：本機 `gh auth status` 顯示未登入，尚未建立 `[test] ` draft PR。已透過存取卡請求 `GITHUB_PAT`；取得後先用 `GH_TOKEN="$GITHUB_PAT" gh auth status` 驗證 CLI 登入，再開測試 PR，驗收後立即關閉並刪除測試分支。

### T1.14 本機 API 與 WebSocket token 認證

- 本機 Linux 相關測試：`pnpm exec vitest run packages/server/src/server.test.ts packages/config/src/config.test.ts apps/web/src/vite-config.test.ts` 通過（63/63）。測試使用假 token／fake runtime，沒有呼叫真實模型或外部 API。
- Playwright E2E 與 macOS、Windows CI 留待 PR CI 驗證；本機未執行這些平台測試。

### T1.12 Repo provider allowlist

- Repo allowlist 預設涵蓋所有 provider，並在 DB/API 寫入時拒絕空值或重複值；只檢查所選任務模式實際使用的角色。建立任務、resume 前與 provider dispatch 前均檢查；更新 allowlist 不取消或改變已執行中的任務，只影響後續建立、resume 與 dispatch。
- 本機 Linux：`pnpm exec vitest run packages/server/src/server.test.ts packages/db/src/database.test.ts packages/db/src/repositories.test.ts` 通過（72/72）；`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 通過（236 passed、2 skipped）。測試使用 fake providers，沒有呼叫真實模型或外部 API。
- macOS／Windows 與 web E2E 留待此 PR 的 CI 驗證；本機未執行這些平台測試。

## 已確認決策

- T1.14 採用 PR #73；PR #74 以留言「改採 #73」關閉。PR #46、#70 已由 #71 取代；已留言說明重複原因並請作者關閉。
- T1.12 allowlist 變更於新任務建立、resume 及 provider dispatch 前檢查；既有執行中任務不因設定變更而中途取消，避免在執行期間改變 provider 選擇。
- T1.12 provider 預檢若在建立 attempt 前拒絕，寫成 task-level failure event，不建立假的 provider attempt；此事件共用 task-wide sequence，並用獨立資料表維持無 attempt 時的事件回放。此時沒有 provider session，task 不可 resume；錯誤訊息要求修正 provider 選擇／allowlist 後建立新 task。已有 attempt 的 resume 拒絕則提示原 provider 固定，須納入 allowlist 或改建新 task。
- T1.9 真實驗收在 Joy repository 開一個標題以 `[test] ` 開頭的測試 draft PR；驗收後立即關閉 PR 並刪除測試分支。
- T2.4 Telegram 審核：🔴 審核 30 分鐘未回應即拒絕，任務停在 `awaiting_approval`，擁有者可在 UI 重新核准。先以 fake Telegram API 實作與測試；bot token 待擁有者提供。
- 預算維持設定預設：OpenAI API 每月上限 30 美元、每任務上限 1 美元；不提高預設值。
- T3.8 依 PLAN 清單評估維護狀況、權限範圍與資料是否送第三方，自行選一個 Gmail／Calendar MCP server；先唯讀，寄信與邀請他人一律 🔴。選型理由寫在本檔決策區。
- 不呼叫真實模型；若測試確實需要真實模型，只能使用 haiku 或 gpt-6-luna、low effort，且必須是 opt-in。
- 每個 ticket 從最新 main 開獨立分支，diff 只保留該 ticket。CI 失敗最多修 3 次；無法修復時記錄原因並繼續不相依工作。

## 擁有者待審

- [PR #58](https://github.com/jimmynycuee/Joy/pull/58)：審核 `packages/core` 公開介面與 `packages/secrets` OS keychain／機密遮罩處理。
- [PR #73](https://github.com/jimmynycuee/Joy/pull/73)：審核本機 API／WebSocket token 認證、token 檔案權限與 Windows ACL 邊界。
- [PR #57](https://github.com/jimmynycuee/Joy/pull/57)：審核 repo provider allowlist 的政策／執行時檢查，以及無 attempt 預檢失敗事件的資料庫與事件格式。
- [PR #76](https://github.com/jimmynycuee/Joy/pull/76)：審核 T1.9 publisher 安全性後續修正：先驗證 Git URL rewrite 後的有效 fetch destination、阻擋 Git LFS pointer commits、以完整 head repository identity／branch／base 比對可重用 PR，並遮罩既有 PR body。針對最新複審指出的 signed size、前置 extension 與大型文字 blob 小修改均已補回歸測試並修正；更新後 head 仍待新一輪獨立審查與 `[test] ` draft PR 真實驗收，尚未核准。

## 需要擁有者處理

- T0.4 Codex 真實 fixture：在已登入且允許執行 Codex CLI 的電腦錄製；指令 `node scripts/record-fixtures.mjs codex`。不要在一般測試或 CI 呼叫真實模型。
- T1.9 真實驗收：透過存取卡提供 `GITHUB_PAT`；先執行 `GH_TOKEN="$GITHUB_PAT" gh auth status` 確認 GitHub CLI 認證，再由此工作階段建立並清理 `[test] ` draft PR。
- T2.4 Telegram：日後透過支援的 Secret 入口提供 `JOY_TELEGRAM_BOT_TOKEN`；不要把 token 貼在對話、文件或程式碼中。
- T3.8 Google：完成所選 MCP server 所需的 Google 登入；登入前保持唯讀功能未連線，登入指令依該 server 文件記錄於此。
- Windows 實機驗收（P4）：在 Windows 電腦執行 `pnpm install --frozen-lockfile` 與 `pnpm check`，並依 T4.4 完成一次跨模型任務；不以 CI 取代實機驗收。

## 卡住

- PR #46、#70 的關閉待作者處理：本 Session 的 GitHub 權限拒絕關閉非 Reason Session 開啟的 PR；已留言請作者關閉。除此之外無新增產品功能阻塞；其餘依指定 ticket 順序推進。
