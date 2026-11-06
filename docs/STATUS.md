# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-06（T2.3 修正）
- 目前階段：P1 真實驗收由擁有者在本機處理；P2 按 T2.3 → T2.7b → T2.4 → T2.5 → T2.1 執行，完成後依序進入 P3。

## 驗證結果

### main Windows CI publisher 測試

- main 的 Windows CI 重現 publisher 測試在 Vitest 預設 5 秒 timeout 中超時，隨後暫存 repo 清理回報 `EBUSY`。失敗測試建立兩個 fixture repo，需執行多個序列 Git 子程序。
- 對該測試設定 30 秒 timeout；遞迴刪除暫存目錄加入 10 次、每次 100 ms 的 busy/permission retry。
- 本機 Linux：`pnpm exec vitest run --project github packages/github/src/publisher.test.ts` 通過（17/17）；清除 runner 注入的 Git 身分後 `pnpm check` 通過（197 passed、2 skipped）。`git diff --check` 通過。
- Windows 實際行為需以 GitHub Actions 驗證；本機沒有 Windows 執行環境。

### T2.2 Tool Hub

- 新增 `packages/tools` 的 stdio MCP server，註冊 `ask_peer`、`task_status`、`request_approval`、`approve`；Claude／Codex single task 收到每次執行獨立的 loopback bearer endpoint，peer 以 read-only autonomy 在同一 worktree 執行，並遵守 repo provider allowlist。
- `tool_hub.max_ask_peer_calls` 預設 5、可設 1–100；ask_peer 呼叫寫入 task events，讓同一 task 的額度在 resume 後保留。Claude 的 delegated `approve` 僅自動放行精確匹配的已註冊 `mcp__joy__*` 工具；其他 CLI 權限提示按 T2.3 policy 分級。
- Linux `env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 通過（格式、lint、workspace typecheck、266 passed、2 skipped）；stdio child、allowlist、read-only peer 與額度以 synthetic fixture 測試，尚未用登入中的真實 Claude/Codex CLI 驗收。

### T2.3 Policy

- PR #84 加入各 `ActionKind` 的三層分類與全域 autonomy mode，並以不同且 repository-allowed 的 provider 對紅色動作做唯讀預審；審核不通過、不可用或尚無使用者核准通道時，紅色動作不執行。
- task-level `external_content` 來源經 DB 持久化並由 server 套用到 action policy；即使 hands-off，外部內容來源的動作仍需人工核准。Settings 提供模式選擇。
- identity-sanitized Linux `pnpm check` 通過（PR implementation 的格式、lint、workspace typechecks、346 passed、2 skipped）；`pnpm test:e2e` 通過（4/4），包括 Settings 模式儲存與 startup 可用性。mainline checkout 首輪 E2E 發現舊按鈕名稱 locator，PR 分支改正後全套重跑通過。政策測試使用 fake providers；未呼叫真實 CLI 或模型。

### T2.4b Telegram

- `packages/channels` 的 `TelegramChannel`：長輪詢 `getUpdates`，只接受設定的 chat id；其他 chat 的訊息與按鈕一律丟棄並寫 warning log（已遮罩）。按鈕一律回 `answerCallbackQuery`。錯誤訊息不含 token（token 在 URL 裡）。
- 設定：`channels.telegram.owner_chat_id`（設定頁可填），bot token 存鑰匙圈（`/api/secrets/telegram-bot-token`）或環境變數 `JOY_TELEGRAM_BOT_TOKEN`。**目前在 server 啟動時建立連線，改設定後要重啟 Joy。**
- 待核准時傳附 Approve／Deny 按鈕的訊息（含預審結論）；按下後回覆結果。任務結束時通知（✅／🟡 輪數用完待你決定／❌／⏹）。
- 驗證：channels 單元測試（假 Bot API）與 server 端到端測試（陌生帳號按鈕被丟棄、擁有者核准後工具執行、任務完成通知、訊息不含 token）。尚未用真的 Telegram bot 測試，需擁有者提供 token。

### T2.4a 核准中心與 UI

- 擁有者決定 T2.4 採用方案 A，分三個 PR：核准中心與 UI（本 PR）→ Telegram → 逾時暫停與接續。
- 🔴 動作（Claude 權限請求、Codex app-server 核准請求）先做跨模型預審，再建立 `approvals` 紀錄，等擁有者決定；等待期間任務狀態為 `awaiting_approval`。核准後工具照常執行，拒絕或逾時則不執行。
- 第一個決定生效（資料庫條件更新），之後的決定回 409；重啟時把遺留的待核准項目標成過期。
- 新 API：`GET /api/approvals?status=&taskId=`、`POST /api/approvals/:id/approve|deny`（可附 `note`）。UI 在任務頁上方顯示待核准清單與 Approve / Deny，時間軸顯示請求與結果。
- 逾時預設 30 分鐘（`approvals.timeout_minutes`）；`ownerApprovalChannel: false` 可關閉核准，恢復「直接拒絕、不預審」。
- 已知限制：Claude Code 呼叫 MCP 工具有自己的逾時，若短於設定的等待時間，Claude 端會先放棄並繼續（T2.4c 的暫停只在 Joy 這邊的逾時觸發）。擁有者實機測試時若遇到，把 `approvals.timeout_minutes` 調短即可。

### T2.7b Codex 審核接到 policy

- server 的 Codex 預設改用 app-server（`providers.codex.transport`，預設 `app-server`；設為 `exec` 可退回舊的 `codex exec`）。之前 T2.7 的 adapter 已合併但 server 沒有使用。
- app-server 的核准請求依 worktree 路徑交給該次執行的 policy：`classifyCodexApproval` 判斷指令（解開 `bash -lc '…'`）、cwd 與寫入根目錄；🟢／🟡 回 `accept`（每次重新判斷，不用 `acceptForSession`），🔴 回 `decline`。找不到對應執行（例如 review loop 的唯讀審查者）一律 `decline`。
- UI 時間軸以文字顯示權限判定與預審結果，🔴 標紅、🟡 標黃。
- 啟動 CLI 時 cwd 不存在，錯誤訊息改為「工作目錄不存在」，不再誤報 CLI 未安裝。
- 驗證：server 以假的 app-server 子行程端到端測試（安全指令 accept、worktree 外寫入 decline、policy 事件寫入）；真實 Codex 聯調仍列在 T0.4。

### T2.3 擁有者審查後的修正（PR #84）

- Claude 的 `Bash`：只有單一、無 shell 語法的 `pnpm`／`npm`／`yarn` 的 test、lint、build、typecheck、check、format:check，與 `git status`／`diff`／`log`／`show` 視為 worktree 內執行（🟢）；其他一律 🔴。
- `Read`／`Glob`／`Grep` 也檢查路徑：worktree 外（例如 `~/.ssh`、`~/.joy`）一律 🔴。寫入工具接受指向 worktree 內的絕對路徑。
- 只有 `mcp__joy__` 開頭的 `ask_peer`、`task_status` 有特別待遇；其他 server 同名工具視為未知（🔴）。
- 在人工核准管道（T2.4）完成前，`ownerApprovalChannel` 預設關閉：🔴 動作直接拒絕，不做跨模型預審，避免白白消耗額度。T2.4 完成時開啟。

### T1.9 GitHub publisher

- T1.9 publisher 安全與歷史掃描補強已由 PR #76 整合至 main；PR 四項檢查與 merge 後 main CI run #42153057409 均通過。
- 本機 `pnpm exec vitest run --project github packages/github/src/publisher.test.ts` 通過（35/35）；identity-sanitized `pnpm check` 通過（格式、lint、typecheck；254 passed、2 skipped）。
- 真實驗收尚未執行；由擁有者在 Mac 以既有 GitHub CLI 登入完成，具體步驟列於「需要擁有者處理」。不需要也不會索取 PAT。

### T1.14 本機 API 與 WebSocket token 認證

- 本機 Linux 相關測試：`pnpm exec vitest run packages/server/src/server.test.ts packages/config/src/config.test.ts apps/web/src/vite-config.test.ts` 通過（63/63）。測試使用假 token／fake runtime，沒有呼叫真實模型或外部 API。
- Playwright E2E 與 macOS、Windows CI 留待 PR CI 驗證；本機未執行這些平台測試。

### T1.12 Repo provider allowlist

- Repo allowlist 預設涵蓋所有 provider，並在 DB/API 寫入時拒絕空值或重複值；只檢查所選任務模式實際使用的角色。建立任務、resume 前與 provider dispatch 前均檢查；更新 allowlist 不取消或改變已執行中的任務，只影響後續建立、resume 與 dispatch。
- 本機 Linux：`pnpm exec vitest run packages/server/src/server.test.ts packages/db/src/database.test.ts packages/db/src/repositories.test.ts` 通過（72/72）；`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 通過（236 passed、2 skipped）。測試使用 fake providers，沒有呼叫真實模型或外部 API。
- macOS／Windows 與 web E2E 留待此 PR 的 CI 驗證；本機未執行這些平台測試。

### T2.7 Codex app-server adapter

- PR #81 已合併為 Codex app-server adapter；PR 的 Windows、Ubuntu、macOS 與 web E2E 四項檢查通過，merge 後 main CI run #42154866526 attempt 2 亦四項全綠。
- D 項取消的 main CI run #42078018953 已只重跑 macOS job 一次（attempt 3）；macOS、Ubuntu、Windows 與 web E2E 均通過。
- 真實 app-server fixture／聯調仍列在 T0.4；policy/UI 審核接線另列 T2.7b。

## 已確認決策

- T1.14 採用 PR #73；PR #74 以留言「改採 #73」關閉。PR #46、#70（由 #71 取代）與重複的 #66 已於 2026-11-06 關閉。
- T1.12 allowlist 變更於新任務建立、resume 及 provider dispatch 前檢查；既有執行中任務不因設定變更而中途取消，避免在執行期間改變 provider 選擇。
- T1.12 provider 預檢若在建立 attempt 前拒絕，寫成 task-level failure event，不建立假的 provider attempt；此事件共用 task-wide sequence，並用獨立資料表維持無 attempt 時的事件回放。此時沒有 provider session，task 不可 resume；錯誤訊息要求修正 provider 選擇／allowlist 後建立新 task。已有 attempt 的 resume 拒絕則提示原 provider 固定，須納入 allowlist 或改建新 task。
- T1.9 真實驗收由擁有者在 Mac 使用 Joy 測試 repo 與既有 GitHub CLI 登入，建立 `[test] ` draft PR 並驗證 publisher 結果；驗收後關閉 PR、刪除測試分支，不提供或索取 PAT。
- T2.4 Telegram 審核：🔴 審核 30 分鐘未回應即拒絕，任務停在 `awaiting_approval`，擁有者可在 UI 重新核准。先以 fake Telegram API 實作與測試；bot token 待擁有者提供。
- 預算維持設定預設：OpenAI API 每月上限 30 美元、每任務上限 1 美元；不提高預設值。
- T3.8 依 PLAN 清單評估維護狀況、權限範圍與資料是否送第三方，自行選一個 Gmail／Calendar MCP server；先唯讀，寄信與邀請他人一律 🔴。選型理由寫在本檔決策區。
- 不呼叫真實模型；若測試確實需要真實模型，只能使用 haiku 或 gpt-6-luna、low effort，且必須是 opt-in。
- 每個 ticket 從最新 main 開獨立分支，diff 只保留該 ticket。CI 失敗最多修 3 次；無法修復時記錄原因並繼續不相依工作。

### T2.5 額度交接與成本上限

- 執行中收到 `quota: limited`（Claude `rate_limit_event`、OpenAI 429、Codex app-server 額度事件）且這次執行失敗時，依 `fallback.on_rate_limit`：
  - `swap_provider`（預設）：在同一個 worktree 交給另一家（依角色設定挑選：可改檔、repo 允許、目前沒有超額），新的 attempt 收到交接摘要（任務、目前 diff、前一位的最後訊息）。每個任務只交接一次。
  - 沒有人能接手，或設為 `queue`：任務排隊，事件 `quota.queued` 記下接續時間（額度重置後 60 秒）；時間到用同一個 session 接續。重啟後依事件重新排程。
  - `fail`：照舊失敗。
- 成本上限：單一任務的 OpenAI API 花費超過 `budget.per_task.max_api_usd` 就停止；執行超過 `budget.per_task.max_minutes` 就停止；本月 OpenAI API 花費達到 `budget.openai_api_usd_monthly_cap` 後，所有 OpenAI API 執行在送出請求前就被拒絕。訂閱 CLI 回報的金額只是估算，不計入。
- `GET /api/quota`：各家目前的額度狀態與本月 API 花費；UI 左下角顯示。
- 限制：交接目前只在單一模式（single）；review loop 與競賽模式的交接留待之後。

### T2.4c 逾時暫停與接續

- 核准逾時（`approvals.on_timeout: pause`，預設）時，Joy 中止這次執行，任務停在 `awaiting_approval`，事件 `task.paused`。設為 `deny` 則維持舊行為：告訴 agent 未核准，任務繼續。
- 逾時的請求仍可在 UI（或 Telegram）核准：Joy 用同一個 session 接續，告訴 agent 擁有者已核准、請重試，且**只放行那一個動作一次**（以遮罩後的動作內容比對）。事後拒絕則任務變成 `failed`；暫停中的任務可以取消。
- 只有「無人回應而逾時」的請求可事後核准；因取消或重啟而過期的不行。重啟後暫停中的任務變成 `failed`，但其逾時請求仍可核准並接續。
- 驗證：server 端到端測試（逾時暫停 → 事後核准 → 同 session 接續、同一動作放行一次、重複核准 409；事後拒絕 → failed；暫停中取消）。

### T1.9b 開 PR 接上 server 與 UI

- `POST /api/tasks/:id/publish`（可選 `title`、`baseBranch`）：只允許已完成的任務；需要 repo 設定 `githubRemote`（`PATCH /api/repos/:id` 可設定或清除）；同一任務同時只能發佈一次。擁有者按下按鈕即視為核准推送與開 draft PR。
- 使用 `GitHubPublisher`，commit 走 executor，遮罩與推送前掃描用同一個 `Redactor`；PR 描述附最後一輪審查結論與 findings。
- 事件：`publish.started`／`publish.done`（PR 連結）／`publish.failed`（已遮罩）。
- UI：已完成任務的 Changes 欄上方有「Open draft PR」；沒有 GitHub remote 時先顯示輸入欄。
- 驗證：server 測試用假 publisher；真實推送與開 PR 由擁有者在 Mac 驗收（見下）。

## 擁有者待審

2026-11-06 由 agent 代為審查（擁有者授權）。下表為結論；擁有者可只看「發現」欄。

| 項目                          | 審查方式                 | 結論       | 發現                                                                                                                          |
| ----------------------------- | ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| #73 本機 API／WebSocket token | 獨立審查（非作者）       | 通過       | Windows 上 token 檔只依賴使用者資料夾的預設 ACL，T4.4 實機確認                                                                |
| #54 GitHub publisher          | 獨立審查                 | 已修       | 內容掃描認不得私鑰與 AWS／Slack／Google／Stripe／GitLab 憑證 → 已加入 Redactor；**publisher 從未接到 server/UI → 新增 T1.9b** |
| #57 provider 允許清單         | 獨立審查                 | 通過       | —                                                                                                                             |
| #58 core 介面、機密遮罩       | 獨立審查                 | 通過       | —                                                                                                                             |
| #62 `joy doctor` 鑰匙圈       | 獨立審查                 | 通過       | 只查詢隨機、不存在的帳號                                                                                                      |
| #84 權限規則                  | 擁有者已審（2026-11-06） | 通過       | —                                                                                                                             |
| T2.7b、T2.4a、T2.4b           | `/code-review`（high）   | 已修 9／10 | 見下                                                                                                                          |

`/code-review` 的發現與處理：重啟時等待核准的任務會卡住（已修）；核准紀錄的 detail 未遮罩（已修）；同任務多個待核准時狀態被提早改回（已修）；Telegram 群組中任何人可按核准（已修，只接受擁有者本人的私訊）；同步決定要等到逾時才生效（已修）；UI 每個事件都重抓待核准清單（已修）；沒有 token 時每分鐘警告（已修，只警告一次）；完成通知未遮罩（已修）；命名與重複程式（已修）；**Telegram 設定要重啟才生效（未修，留待之後）**。

## 需要擁有者處理

- T0.4 Codex 真實 fixture／app-server 聯調：在擁有者已登入且可執行 Codex CLI 的 Mac 錄製，指令 `node scripts/record-fixtures.mjs codex`；以真實 fixture 重跑 contract test，並在 Joy 上驗證 app-server 連線及事件／額度互通。不要在一般測試或 CI 呼叫真實模型。
- T1.9 真實驗收（擁有者 Mac）：使用該 Mac 上既有的 GitHub CLI 登入；啟動 Joy，對測試 repo 跑完一個小任務後按 Changes 欄的「Open draft PR」（第一次會要求填 GitHub repository URL），確認遠端測試分支、標題以 `[test] ` 開頭的 draft PR 與 review 摘要正確；驗收後關閉測試 PR 並刪除測試分支。不提供、不貼上或索取 PAT。
- T1.13/T1.8（擁有者 Mac）：審查 PR #62 的鑰匙圈可用性探測後，在目標 Mac 執行 `pnpm joy doctor`，確認首頁顯示該機器的 CLI、鑰匙圈與資料目錄檢查；此驗收不讀取或提供已存憑證。
- T2.4 Telegram（**擁有者決定暫緩**）：在 @BotFather 建 bot，對它傳一則訊息後用 `https://api.telegram.org/bot<token>/getUpdates` 查自己的 chat id；在 Joy 設定頁填入 chat id 與 bot token（或用環境變數 `JOY_TELEGRAM_BOT_TOKEN`），重啟 Joy。不要把 token 貼在對話、文件或程式碼中。
- T3.8 Google：完成所選 MCP server 所需的 Google 登入；登入前保持唯讀功能未連線，登入指令依該 server 文件記錄於此。
- Windows 實機驗收（P4）：在 Windows 電腦執行 `pnpm install --frozen-lockfile` 與 `pnpm check`，並依 T4.4 完成一次跨模型任務；不以 CI 取代實機驗收。

## 卡住

- 無。
