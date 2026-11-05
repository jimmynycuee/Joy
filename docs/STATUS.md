# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-05 UTC
- 目前階段：**P1 尚未完成；P2 依計畫順序暫停。** `t1.13-doctor` 已整合最新 `main`（`ed1560a7af0527c286c569e533203507c8bc4d5a`），衝突修復後本地驗證通過；更新後的 PR CI 以 live 狀態為準。T1.13 與 T1.8 首頁檢查仍待 owner review/merge，保持未勾選，不標 ready 或合併。

## 驗證結果

### main Windows CI publisher 測試

- main 的 Windows CI 重現 publisher 測試在 Vitest 預設 5 秒 timeout 中超時，隨後暫存 repo 清理回報 `EBUSY`。失敗測試建立兩個 fixture repo，需執行多個序列 Git 子程序。
- 對該測試設定 30 秒 timeout；遞迴刪除暫存目錄加入 10 次、每次 100 ms 的 busy/permission retry。
- 本機 Linux：`pnpm exec vitest run --project github packages/github/src/publisher.test.ts` 通過（17/17）；清除 runner 注入的 Git 身分後 `pnpm check` 通過（197 passed、2 skipped）。`git diff --check` 通過。
- Windows 實際行為需以 GitHub Actions 驗證；本機沒有 Windows 執行環境。

### T1.13 `joy doctor` 與首頁首次啟動檢查

- 實作涵蓋 Node、Git、GitHub CLI 登入狀態、Claude/Codex CLI、OS keychain 可用性及 Joy 資料目錄可寫入狀態；首頁顯示檢查結果與修復指引。Windows npm `.cmd`/`.bat` shim 僅以檔案存在性辨識並標示版本未測；低於 Node 22.13 的版本標示為不支援；缺少資料目錄的指引說明啟動 server 會自動建立。
- 最新 main 整合及衝突修復後，`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 通過：Prettier、ESLint、workspace typechecks；225 tests passed、2 skipped（含 7 個 doctor tests 與 41 個 server tests）。另執行 `pnpm exec vitest run packages/server/src/server.test.ts`（41/41 passed）及 `pnpm --filter @joy/web exec playwright test e2e/doctor.spec.ts`（1/1 passed）。首頁 E2E 使用 fake `/api/doctor` 回應；Windows 情境使用 `win32` 注入與 fake `.cmd`/暫存目錄。未在原生 Windows 執行，未呼叫真實模型 CLI、GitHub CLI auth 或讀取 keychain/訂閱憑證。
- T1.13/T1.8 在 owner review 與 merge 前保持未勾選、P2 繼續暫停。

### T1.14 本機 API 與 WebSocket token 認證

- 本機 Linux 相關測試：`pnpm exec vitest run packages/server/src/server.test.ts packages/config/src/config.test.ts apps/web/src/vite-config.test.ts` 通過（63/63）。測試使用假 token／fake runtime，沒有呼叫真實模型或外部 API。
- Playwright E2E 與 macOS、Windows CI 留待 PR CI 驗證；本機未執行這些平台測試。

## 已確認決策

- T1.14 採用 PR #73；PR #74 以留言「改採 #73」關閉。PR #46、#70 已由 #71 取代；已留言說明重複原因並請作者關閉。
- T1.9 真實驗收在 Joy repository 開一個標題以 `[test] ` 開頭的測試 draft PR；驗收後立即關閉 PR 並刪除測試分支。
- T2.4 Telegram 審核：🔴 審核 30 分鐘未回應即拒絕，任務停在 `awaiting_approval`，擁有者可在 UI 重新核准。先以 fake Telegram API 實作與測試；bot token 待擁有者提供。
- 預算維持設定預設：OpenAI API 每月上限 30 美元、每任務上限 1 美元；不提高預設值。
- T3.8 依 PLAN 清單評估維護狀況、權限範圍與資料是否送第三方，自行選一個 Gmail／Calendar MCP server；先唯讀，寄信與邀請他人一律 🔴。選型理由寫在本檔決策區。
- 不呼叫真實模型；若測試確實需要真實模型，只能使用 haiku 或 gpt-6-luna、low effort，且必須是 opt-in。
- 每個 ticket 從最新 main 開獨立分支，diff 只保留該 ticket。CI 失敗最多修 3 次；無法修復時記錄原因並繼續不相依工作。

## 擁有者待審

- [PR #58](https://github.com/jimmynycuee/Joy/pull/58)：審核 `packages/core` 公開介面與 `packages/secrets` OS keychain／機密遮罩處理。
- [PR #62](https://github.com/jimmynycuee/Joy/pull/62)：審核 T1.13 doctor 與 T1.8 首頁檢查；保留 draft，合併由擁有者處理。
- [PR #73](https://github.com/jimmynycuee/Joy/pull/73)：審核本機 API／WebSocket token 認證、token 檔案權限與 Windows ACL 邊界。
- T1.12 / PR #53 的 owner-review gate 與 PR #57 的 shared-head 限制維持不變；本分支不修改這兩個 PR 或其共享分支。

## 需要擁有者處理

- T0.4 Codex 真實 fixture：在已登入且允許執行 Codex CLI 的電腦錄製；指令 `node scripts/record-fixtures.mjs codex`。不要在一般測試或 CI 呼叫真實模型。
- T2.4 Telegram：日後透過支援的 Secret 入口提供 `JOY_TELEGRAM_BOT_TOKEN`；不要把 token 貼在對話、文件或程式碼中。
- T3.8 Google：完成所選 MCP server 所需的 Google 登入；登入前保持唯讀功能未連線，登入指令依該 server 文件記錄於此。
- Windows 實機驗收（P4）：在 Windows 電腦執行 `pnpm install --frozen-lockfile` 與 `pnpm check`，並依 T4.4 完成一次跨模型任務；不以 CI 取代實機驗收。

## 卡住

- T1.9 仍需依 PLAN 的安全測試 repo 流程完成實際驗收；fake `gh`／local bare remote 不足以勾選。
- PR #46、#70 的關閉待作者處理：本 Session 的 GitHub 權限拒絕關閉非 Reason Session 開啟的 PR；已留言請作者關閉。
- 目前沒有新增的產品功能阻塞。P1 及明列的擁有者處理項目完成前，P2 保持暫停。
