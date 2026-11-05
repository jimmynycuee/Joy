# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-05 UTC
- 目前階段：**P1 尚未完成；P2 依計畫順序暫停。** T1.13 的 doctor 與首頁檢查已在 PR #62 分支以 forward-only merge 整合 live main `c8b8c3a8d4f368ef351108eb3a22e26bccb776cf`；最新合併樹的本機 `pnpm check`（262 passed、2 skipped）及首頁 doctor E2E（1 passed）通過。PR #62 保持 draft；更新後 CI、owner review 與實機驗收仍待完成。T1.13/T1.8 保持未勾選。

## 驗證結果

### T1.9 GitHub publisher

- Publisher 實作已整合至 main；對上游 repo/fork、base ancestry、推送 commits 的敏感檔名／二進位／secret-like 新增內容與 commit message 做檢查，並限制 Git/gh 子程序時間與診斷輸出。
- 本機 `pnpm exec vitest run --project github packages/github/src/publisher.test.ts` 通過（35/35）；`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 通過（254 passed、2 skipped）。
- 依 PLAN，真實驗收仍待在 Joy 測試 repo 建立並清理標題以 `[test] ` 開頭的 draft PR。

### T1.13 `joy doctor` 與首頁首次啟動檢查

- Doctor 涵蓋 Node、Git、GitHub CLI 登入狀態、Claude/Codex CLI 安裝與偵測版本、OS keychain 可用性及 Joy 資料目錄可寫入狀態；首頁顯示檢查結果及修復指引。低於 Node 22.13 的版本標示為不支援；缺少資料目錄的指引說明 server 啟動時會以 POSIX `0700` 建立。API token 檔案維持 POSIX `0600`。
- Windows `.cmd`/`.bat` shim 以檔案存在性辨識並標示版本未測，包含自訂 command 名稱；測試使用假檔，未在原生 Windows 驗證。
- Keychain probe 只檢查可用性，使用新的隨機帳戶查詢；不讀取已儲存的憑證或訂閱資料。
- 安全修正後 `pnpm exec vitest run packages/server/src/doctor.test.ts packages/server/src/server.test.ts` 通過（59/59）；`pnpm --filter @joy/web exec playwright test e2e/doctor.spec.ts` 通過（1/1，使用 fake `/api/doctor` 回應）；完整 `pnpm check` 通過（Prettier、ESLint、workspace typechecks；262 passed、2 skipped）。`git diff --check` 及 POSIX 新目錄權限 regression 亦通過；修正前測試重現 `0755`，修正後為 `0700`。server test 另驗證未帶 token 的 `/api/doctor` 回傳 403。
- 本機 Linux 未在原生 Windows 驗證；未呼叫真實 Claude/Codex CLI、GitHub CLI 認證命令或模型，也未讀取 keychain／訂閱憑證；production/deployed behavior 未驗證。
- T1.13/T1.8 保持未勾選，直到 owner review 與驗收完成；P2 依 PLAN 順序暫停。

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

以下變更涉及權限、機密或核心介面；owner review 完成前，相應 roadmap 項目保持未勾選：

- [PR #54](https://github.com/jimmynycuee/Joy/pull/54)（已合併）：審核 T1.9 publisher 的 push target、commit history 與 secret-safety 檢查。
- [PR #57](https://github.com/jimmynycuee/Joy/pull/57)（已合併）：審核 T1.12 provider allowlist 的建立、resume 與 dispatch 權限邊界。
- [PR #58](https://github.com/jimmynycuee/Joy/pull/58)（已合併）：審核 `packages/core` 公開介面與 `packages/secrets` keychain／機密處理。
- [PR #73](https://github.com/jimmynycuee/Joy/pull/73)（已合併）：審核 T1.14 本機 API token、Origin 與 WebSocket 認證，以及 token 檔案權限／Windows ACL 邊界。
- [PR #62](https://github.com/jimmynycuee/Joy/pull/62)：審核 T1.13 doctor 與 T1.8 首頁檢查；保留 draft。review follow-ups 包含 Windows `.cmd`/`.bat` shim 狀態、Node 低於 22.13 的不支援提示，以及資料目錄自動建立指引；keychain probe 僅檢查可用性、不讀取已儲存憑證。
- [PR #66](https://github.com/jimmynycuee/Joy/pull/66)：審核 T1.8 的 OpenAI key／SecretStore UI 與機密處理；依 repository 規則需 owner review。
- [PR #76](https://github.com/jimmynycuee/Joy/pull/76)：審核 T1.9 publisher 的 Git URL rewrite、Git LFS、PR 身分比對與 body redaction 安全補強。
- T1.12 / PR #53 的 owner-review gate 與 PR #57 的 shared-head 限制維持不變；本分支不修改這兩個 PR 或其共享分支。

## 需要擁有者處理

- T0.4 Codex 真實 fixture：在已登入且允許執行 Codex CLI 的電腦錄製；指令 `node scripts/record-fixtures.mjs codex`。不要在一般測試或 CI 呼叫真實模型。
- T1.13 實機驗收：在 owner 的開發機執行 `pnpm joy doctor`，確認該機 CLI 與 keychain availability 結果；此指令不執行模型，也不讀取已儲存憑證。
- T1.9 真實驗收：透過存取卡提供 `GITHUB_PAT`；先執行 `GH_TOKEN="$GITHUB_PAT" gh auth status` 確認 GitHub CLI 認證，再由此工作階段建立並清理 `[test] ` draft PR。
- T2.4 Telegram：日後透過支援的 Secret 入口提供 `JOY_TELEGRAM_BOT_TOKEN`；不要把 token 貼在對話、文件或程式碼中。
- T3.8 Google：完成所選 MCP server 所需的 Google 登入；登入前保持唯讀功能未連線，登入指令依該 server 文件記錄於此。
- Windows 實機驗收（P4）：在 Windows 電腦執行 `pnpm install --frozen-lockfile` 與 `pnpm check`，並依 T4.4 完成一次跨模型任務；不以 CI 取代實機驗收。

## 卡住

- T1.9 仍需依 PLAN 的安全測試 repo 流程完成實際驗收；fake `gh`／local bare remote 不足以勾選。
- PR #46、#70 的關閉待作者處理：本 Session 的 GitHub 權限拒絕關閉非 Reason Session 開啟的 PR；已留言請作者關閉。
- 目前沒有新增的產品功能阻塞。P1 及明列的擁有者處理項目完成前，P2 保持暫停。
