# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-07（T5.6 自訂工作流程）
- T2.1 平行競賽已用假 provider 完成；擁有者 Codex 額度恢復後可用真實 CLI 跑一次（最便宜模型、low effort）。T3.8 需要 Google 登入，未做。
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

- 2026-11-07 擁有者逐項確認：T5.1、T5.2、T5.3、T5.4、T5.5、T5.7 **全部暫不開始**（T5.6 已依擁有者指示完成）。不要再詢問，等擁有者主動提出。
- 2026-11-07 擁有者決定：T4.1（PR #110）**等擁有者審過再合併**，agent 不合併；T4.3 Tauri **延後**，等擁有者有簽章帳號並決定安裝檔如何附帶 Node 與 Joy；P5 **暫不開始**（依 PLAN「視使用情況決定」）。
- T1.14 採用 PR #73；PR #74 以留言「改採 #73」關閉。PR #46、#70（由 #71 取代）與重複的 #66 已於 2026-11-06 關閉。
- T1.12 allowlist 變更於新任務建立、resume 及 provider dispatch 前檢查；既有執行中任務不因設定變更而中途取消，避免在執行期間改變 provider 選擇。
- T1.12 provider 預檢若在建立 attempt 前拒絕，寫成 task-level failure event，不建立假的 provider attempt；此事件共用 task-wide sequence，並用獨立資料表維持無 attempt 時的事件回放。此時沒有 provider session，task 不可 resume；錯誤訊息要求修正 provider 選擇／allowlist 後建立新 task。已有 attempt 的 resume 拒絕則提示原 provider 固定，須納入 allowlist 或改建新 task。
- T1.9 真實驗收由擁有者在 Mac 使用 Joy 測試 repo 與既有 GitHub CLI 登入，建立 `[test] ` draft PR 並驗證 publisher 結果；驗收後關閉 PR、刪除測試分支，不提供或索取 PAT。
- T2.4 Telegram 審核：🔴 審核 30 分鐘未回應即拒絕，任務停在 `awaiting_approval`，擁有者可在 UI 重新核准。先以 fake Telegram API 實作與測試；bot token 待擁有者提供。
- 預算維持設定預設：OpenAI API 每月上限 30 美元、每任務上限 1 美元；不提高預設值。
- T3.8 依 PLAN 清單評估維護狀況、權限範圍與資料是否送第三方，自行選一個 Gmail／Calendar MCP server；先唯讀，寄信與邀請他人一律 🔴。選型理由寫在本檔決策區。
- 不呼叫真實模型；若測試確實需要真實模型，只能使用 haiku 或 gpt-6-luna、low effort，且必須是 opt-in。
- 每個 ticket 從最新 main 開獨立分支，diff 只保留該 ticket。CI 失敗最多修 3 次；無法修復時記錄原因並繼續不相依工作。

### T5.6 自訂工作流程（擁有者 2026-11-07 指定先做）

- 工作流程格式（`packages/orchestrator/src/workflow.ts`）：名稱、模式（`single`／`review_loop`／`compete`）、各角色用的模型、模式的選項（`max_rounds`、`plan_first`，只適用 review_loop）。
- **原本三種任務模式就是三個內建工作流程**，測試逐一確認用新格式產生的任務與原本的模式完全相同（同模式、不改角色、不改選項）。
- 自訂工作流程寫在 `config.yaml` 的 `workflows:`（不能用內建名稱）；設定錯誤會說明原因（模式用不到的角色、非 review_loop 設了回合數、compete 兩個實作者是同一個模型），這種工作流程不能用來建任務。
- 任務可以用 `workflow` 建立（API、建立任務表單、助理 `create_task`）；工作流程給預設值，請求裡明寫的角色與選項優先。用了哪個自訂工作流程記在任務上（migration 17）。`GET /api/workflows` 列出全部與其問題。
- 驗收：orchestrator 測試（三種模式各自等於內建工作流程、選項帶入、錯誤說明）、server 測試（自訂工作流程的模型、回合數、先規劃都生效並跑完；內建 `single` 與舊模式相同；不存在／有問題／模式衝突回 422）、Playwright `workflows.spec.ts`。

### T4.2 PWA 與 Web Push（程式部分；手機驗收待擁有者）

- 網頁可安裝（`manifest.webmanifest`、圖示），service worker 只負責顯示通知與點通知開到該任務（`/?task=…`），**不做離線快取**（舊 UI 接新 server 比沒有 UI 更糟）。
- 任務結束（✅／🟡／❌）與需要核准（🔴）時，Joy 用自己的 VAPID 金鑰直接送到各瀏覽器的推播服務；內容先經 Redactor 再加密。金鑰第一次使用時產生，存在**鑰匙圈**（新 secret 名稱 `web_push_vapid_keys`，列入待審）。推播服務回 404／410 的訂閱自動刪除。沒有任何訂閱時完全不碰鑰匙圈。
- 設定頁「Notifications」：開啟（要求權限、訂閱、送到 `POST /api/push/subscriptions`）、送測試、關閉。不支援時說明原因（需要 HTTPS 或 localhost；iPhone 要先加到主畫面）。
- 驗收：push 測試（金鑰只產生一次；**用瀏覽器的方式解密**確認內容正確且已遮罩；410 時刪除訂閱）、server 測試（任務完成時對訂閱裝置送出帶 VAPID 的請求；拒絕非 https 端點）、Playwright：manifest、service worker 註冊、**透過 Chromium DevTools 真的推一則訊息，service worker 顯示通知**、開啟流程送出訂閱。
- 手機上要能用：Joy 要能從手機以 HTTPS 開啟（依賴 T4.1 #110 與 `tailscale serve` 之類的 HTTPS；`tailscale serve` 轉送時的 Host 是否被 Joy 接受還沒實測）。「手機加到主畫面後收得到通知」**需擁有者實測，PLAN 未打勾**。

### T4.4 Windows：`.cmd` shim 與 WSL（程式部分；實機驗收待擁有者）

- **修正**：provider 一律不經 shell 啟動 CLI，但 Windows 上 npm／pnpm 裝的 `claude.cmd`、`codex.cmd` 不經 shell 無法啟動，之前任務在 Windows 會直接失敗（只有 doctor 的 `--version` 有繞過）。現在 `packages/providers/src/windows.ts` 會在 PATH 找 `.exe`，否則讀 shim 內容找出它執行的 JavaScript（`cli.js`、`codex.js`），用目前的 Node 直接執行；兩個 spawn 點（JSONL CLI 與 Codex app-server）都套用。讀不懂的 shim 會說明要在設定填 `.exe` 或 `cli.js` 路徑。
- `doctor` 在 Windows 多一項「WSL (for Codex)」：WSL 是否可用、WSL 裡有沒有 Codex 與版本。
- Codex WSL fallback（預設關）：`providers.codex.wsl: true` 且 `transport: exec` 時，`codex exec` 改由 `wsl.exe --cd /mnt/<碟>/… -e codex …` 執行，參數中的 Windows 路徑轉成 `/mnt/…`。
- 驗收：純函式測試（npm 與 pnpm shim、`.exe` 優先、PATH、WSL 路徑轉換）；**Windows CI 實際用 `.cmd` shim 啟動一個 CLI**（只在 Windows runner 執行）；doctor 測試（WSL 三種狀態、非 Windows 不顯示）。
- 安裝檔屬於 T4.3（Tauri）。「Windows 實機完成一次交叉審查任務」需擁有者在 Windows 電腦執行，**PLAN 未打勾**。

### T4.5 container 模式

- repo 可標成 `container`（新增 repo 時勾選，或 `PATCH /api/repos/:id {container}`；migration 15）。這類 repo 的 Claude Code／Codex（exec）改在 `docker run` 裡跑：**只看得到該任務的 worktree、該 repo 的 `.git`、Joy 原始碼（唯讀，給 Tool Hub 橋接用）、這次執行的暫存檔，以及專用的登入資料夾 `~/.joy/container-home/<cli>`**；看不到你的家目錄、其他 repo 與主機上的 CLI 憑證。`--cap-drop ALL`、`no-new-privileges`、以你的 uid 執行。
- 憑證：容器內的 CLI 用專用資料夾登入一次（`pnpm joy container-login claude|codex`），不掛載、不讀取主機的登入。映像檔用 `pnpm joy container-build`（`docker/agent.Dockerfile`：node 22 + git + 兩個 CLI）。
- 網路：`container.network`，預設 `host`（CLI 要連模型 API、Tool Hub 審核要連 Joy 的 127.0.0.1；Linux 直接可用，Docker Desktop 要開 host networking）；`none` 完全斷網（CLI 無法工作，只供離線檢查）。**host 模式下網路沒有隔離**，保護的是檔案系統。
- 限制：Codex app-server 是共用的常駐程序，放不進容器 → container repo 只接受 `providers.codex.transport: exec`（否則任務直接拒絕並說明）。`transport: exec` 現在真的只用 exec（之前仍先試 app-server）。
- 驗收：executor 測試（docker 參數、只掛該掛的路徑、拒絕可注入的路徑）、server 測試（Codex app-server 被拒、PATCH 切換）、**真實 Docker e2e**（`JOY_E2E_DOCKER=1`，不進 CI）：在容器裡跑假 CLI，確認 HOME 是 `/joy-home`、讀不到主機上的檔案、改動出現在 worktree 且檔案擁有者是你；Playwright `container.spec.ts`。
- 本環境驗證不到：映像檔中的 `apt-get install git`（沙盒連不到 Debian 套件庫）；npm 安裝兩個 CLI 已在 node 映像內驗證可執行。

### T4.9 使用者文件（待擁有者驗收）

- README 重寫：需要的工具與檢查指令、安裝、啟動、第一次設定、第一個任務、日常使用（助理、競賽、issue、Stats、worktree、備份）、疑難排解、隱私（依 PLAN §7.1）。
- **補上實際啟動 Joy 的指令**：之前沒有任何指令會啟動真正的 server。新增 `pnpm joy start [--port N]`（127.0.0.1:4317，Ctrl+C／SIGTERM 正常關閉）與 `pnpm web`（Vite UI，讀同一個 token）。已在容器內實測：啟動、`/api/health`、log、備份、pid 檔與關閉後清理。
- 驗收條件「新電腦照 README 15 分鐘內跑完第一個任務」需要擁有者實測，**PLAN 未打勾**。

### T4.6 CLI 版本管理

- 測過的版本範圍在 `packages/providers/src/versions.ts`（`TESTED_CLI_VERSIONS`）：Claude Code 2.1.317、Codex 0.166.0，等於 `tests/fixtures/cli-events/` 錄製時的版本；**有測試確保兩者一致**，重錄後忘了改範圍會失敗。Codex 目前只有沙盒（未登入）錄製，真實聯調仍待 T0.4。
- 啟動時跑 `claude --version`／`codex --version`，未測過的版本寫進除錯 log 與主控台並附重錄指令；`pnpm joy doctor` 與首頁同樣標 `untested`（測過的標 `ok`）。測試一律不呼叫真實 CLI（server 測試以假 runner 驗證）。
- 每週 CI `.github/workflows/cli-contract.yml`（也可手動觸發）：用 `pnpm dlx` 取最新版只跑 `--version`，未測版本出 GitHub warning；再跑 providers contract test（只解析 fixture，不呼叫模型）。
- 重錄流程寫在 `docs/cli-versions.md`。本容器的 Claude Code 是 2.1.319，已被正確標成未測。

### T4.8 除錯 log

- `~/.joy/logs/joy-YYYY-MM-DD.log`（UTC 日），每行一筆 JSON（`ts`、`level`、`msg` 與欄位），**保留 14 天**，換日時刪舊檔；只刪符合檔名格式的檔案。
- **每一筆寫入前整筆經過 Redactor**（訊息與巢狀欄位都會），下載時再遮一次（之後才加入的 secret 也會遮掉）。寫入失敗不影響 Joy，只在主控台警告一次。
- server 原本的 `console.warn` 全部改走 log（警告與錯誤仍印到主控台）；另記錄啟動、任務開始與結束（狀態、原因）。
- `GET /api/logs`、`GET /api/logs/:day`（只接受日期格式）；設定頁「Debug logs」可下載。
- 驗收：log 測試（訊息、巢狀欄位、OpenAI key 格式都找不到 secret；換日與保留 14 天）、server 測試（任務錯誤訊息含 secret，log 檔與下載內容都找不到；非日期路徑 404）、Playwright（下載）。

### T4.7 備份與匯出

- Joy 啟動時與之後每小時檢查一次：當天（UTC）沒有備份就用 `VACUUM INTO` 寫到 `~/.joy/backups/joy-YYYY-MM-DD.sqlite`（先寫暫存名再改名，不會留下半份），**只保留最新 7 份**。
- 還原：**先停 Joy**，再 `pnpm joy restore 2026-11-06`（或備份檔路徑）。會先檢查檔案完整且是 Joy 資料庫、版本不比目前新；被取代的資料庫另存成 `joy.sqlite.before-restore-<時間>.sqlite`；舊的 WAL 檔會刪掉以免套到還原檔上。Joy 執行中（`~/.joy/server.pid` 的程序還活著）就拒絕。`pnpm joy backup` 手動備份。
- `GET /api/export` 下載 JSON：repo、任務（含嘗試、審查、事件）、所有記憶、對話與訊息、專案筆記、提醒與排程，**整份經過 Redactor**。設定頁「Backups & export」：備份清單、立即備份、下載匯出、還原指令。
- 驗收：db 測試（一天一份、保留 7 份、還原後資料與備份一致且保留被取代的版本、拒絕非 Joy 檔案）、CLI 測試（Joy 執行中拒絕、過期 pid 不擋）、server 測試（啟動即備份、匯出看不到已知 secret）、Playwright `apps/web/e2e/backups.spec.ts`。

### T2.6 GitHub issue → 任務

- 有設 GitHub remote 的 repo，每 `github.issue_poll_minutes`（預設 5，0 關閉）用擁有者已登入的 `gh` 查詢帶 `github.issue_label`（預設 `joy`，大小寫不分）的 open issue，**每個 issue 只建一個任務**（migration 14 `issue_imports`；建立失敗會釋放，下次再試）。Pull request 不算。
- 助理工具 `import_github_issue(repo_id, issue_number)`：擁有者說「do #123」時使用；已匯入過就回傳原任務。
- 任務一律 `provenance: external_content`；prompt 先寫 Joy 的指示，issue 標題、標籤、內文放在 `<<<ISSUE … ISSUE>>>` 區塊當資料。**由它提出的動作在任何自主模式下都要擁有者核准**（`packages/policy` 既有規則：external_content 一律 🔴）。
- 沿用 `packages/github` 既有的 issue 驗證 adapter；新增 `GhIssueSource`（`gh api`，不經手 token，`shell: false`）。輪詢失敗同一個 repo 只警告一次。
- 驗收：`packages/github` 測試（假 `gh`：排除 PR、錯誤訊息）、db 測試（只匯入一次、失敗可重試）、server 測試（label 輪詢多次只建一個任務、標記 external_content、issue 內容在資料區塊、「do #N」匯入與重複回傳）。

### T2.8 worktree 清理

- 開 PR 成功後立即刪除該嘗試的 worktree（分支已在 GitHub），記為 `worktree.removed`；之後再按「開 PR」回 409。compete 選定後其他嘗試照舊立即清除。
- 設定頁「Worktrees」：每個 Joy worktree 的任務、大小、閒置天數、未推送 commit 數與總磁碟用量；閒置超過 `worktrees.stale_after_days`（預設 14，可改）標成 idle。**只在擁有者按 Remove 時刪除**，不會自動刪。
- 任務完成（done／review_ready／failed／cancelled）且未開 PR 時有「Discard worktree」。
- **有未推送 commit 的 worktree 一律先回 409**，UI 再問一次，確認後才帶 `confirmUnpushedCommits: true` 刪除；執行中的任務不能刪；只接受 Joy 自己列出的路徑（`POST /api/worktrees/remove`、`POST /api/tasks/:id/discard`）。
- 沿用 `packages/executor` 既有的 `listWorktrees`／`cleanup` 守門（未改 core 介面）。比對路徑時先解析 symlink（macOS 暫存目錄在 `/private/var`）。
- 驗收：server 測試用真的 git repo 與 worktree（未推送 commit 未確認不刪、執行中不刪、非 Joy 路徑 404、確認後刪除、discard）；開 PR 後清除；Playwright `apps/web/e2e/worktrees.spec.ts`。

### T2.1 平行競賽

- 任務模式 `compete`：`roles.implementer` 與 `roles.reviewer` 兩個模型各在自己的 worktree **同時**做同一件事（兩者都必須能改程式碼），各自被另一個模型審查一次；兩個都有成果時，`roles.judge` 唯讀比較並給理由（選誰、各自優缺點、是否建議合併）。只有一個有成果就不叫裁判。
- 任務停在 `review_ready`，UI 並排顯示兩個嘗試的 diff、審查結果與裁判理由：
  - 「Choose A/B」：`POST /api/tasks/:id/choose {attemptId}`，任務變 `done`，**其他嘗試的 worktree 立即清除**（擁有者的選擇就是確認；有未推送 commit 的不會被刪，只記警告）。開 PR（T1.9b）用選中的嘗試。
  - 「Merge」：`POST /api/tasks/:id/merge {}`，裁判在**第三個 worktree** 參考兩份 diff 與自己的比較重新實作，再由和裁判不同家的參賽模型審查一次；合併版有自己的分支與審查紀錄，之後一樣用 Choose 選。裁判必須能改程式碼（設成 Claude Code 或 Codex）。
- 允許清單：建立任務時檢查實作者、審查者、裁判三個 provider（T1.12）；合併時再查一次裁判與合併審查者。
- 參賽者各自的結束事件記為 `compete.result`（不是任務結束）；裁判結論 `compete.judgement`、合併 `compete.merge_started`/`compete.merged`、選擇 `compete.chosen` 都是任務層級事件。審查寫進 `reviews`，所以 T3.9 統計也算得到。
- 限制：compete 任務不能 resume（重啟中斷就重開一個）；額度交接（T2.5）只用在單一模式；合併執行沒有套用每任務時間上限。
- 驗收：`packages/orchestrator` 測試（兩個嘗試真的並行、各審一次、裁判輸出驗證、只有一個成果時跳過裁判）、server 測試（並行→審查→裁判→合併→選擇→清理；裁判不在允許清單時拒絕）、Playwright `apps/web/e2e/compete.spec.ts`。

### T3.9 模型表現統計

- `GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&repoId=`（日期以 UTC 整天計，`to` 含當天）；導覽列新增「Stats」頁，可選期間與 repo。
- 實作者（依 provider、模型、任務模式分組；Joy 沒有任務分類欄位，以模式代替「各類任務」）：嘗試次數、通過率（成功且最後一輪審查核准；取消的不計）、審查在它的成果裡找到的問題數、平均耗時、因額度用完交接出去的次數。審查者：審查次數、核准次數、找到的問題數。
- 只讀既有的 attempts、reviews、events，不新增資料表。
- 驗收：db 測試（各項數字、期間與 repo 篩選）、server 測試（日期格式錯誤回 400）、Playwright `apps/web/e2e/stats.spec.ts`。

### T3.7 排程

- 新套件 `packages/scheduler`：五欄 cron（本機時間；`*`、清單、範圍、間隔；兩個日期欄都有限制時任一符合即可）與排程器。提醒與定時工作存在 SQLite（migration 13：`reminders`、`schedules`；v1 未使用的 `schedules` 佔位表被替換），重啟後仍有效。
- 排程器最多睡 60 秒就醒來檢查，所以電腦睡醒或 Joy 重新啟動後一分鐘內補上：**錯過的提醒立刻送出並標「late by …」；錯過多次的定時工作只跑最近一次**，訊息註明跳過幾次。同一次不會跑兩次（以 `next_run_at` 條件更新）。
- 提醒送到原對話（對話已刪就送到「Reminders」對話），有設定 Telegram 時也送一份。定時工作可以是提醒或程式任務（走 `startTask`，有 repo allowlist 與預算等原本的檢查）。
- 助理工具 `create_reminder`、`create_schedule`、`list_schedules`、`cancel_schedule`；`GET/POST /api/schedules`、`POST /api/reminders`、`DELETE /api/schedules/:id`；助理頁左側「Scheduled」可取消。
- 驗收：假時鐘測試（`packages/scheduler`：睡 3 小時後提醒標延遲、每小時工作只補跑一次、重啟後仍有效、並行 tick 不重複）；server 測試（關掉 server、時鐘前進 3 小時再啟動）；Playwright `apps/web/e2e/scheduled.spec.ts`。

### T3.6 事件記憶

- 每段對話累積 4 則新的擁有者／Joy 訊息後，背景模型（`roles.background`）更新該對話的摘要（最多 1500 字，經 Redactor），存在 `conversations.summary`。
- migration 12：`messages_fts`（綁 `messages.id` 整數主鍵）與 `conversation_summaries_fts`（以對話 id 為欄位、刪除對話時一起刪）。只搜尋擁有者與 Joy 的訊息，不含錯誤訊息。
- 摘要**只供搜尋**，不會自動放進助理的指示，也不寫入 memories（摘要含助理回覆與工具結果，不符合 T3.3「只採用擁有者本人的話」的規則）。
- 助理工具 `search_history(query)`；`GET /api/history?q=`；助理頁左側搜尋框，點結果開啟該對話。
- 驗收：db 測試（一個月前的訊息與摘要都找得到、刪除對話後找不到）、server 測試（摘要觸發與助理透過工具找回一個月前的決策）、Playwright `apps/web/e2e/history.spec.ts`。
- 未做：OpenAI embedding 語意搜尋（PLAN 標為選配；需花 API 額度，先不做）。

### T3.5 專案記憶

- 助理工具 `propose_project_note(repo_id, note)` **只建立提議**，不寫檔；助理沒有任何套用的工具。提議存成 `project_notes`（migration 11），記錄提議當時 `AGENTS.md` 的 SHA-256 與套用後的完整內容。
- 擁有者在助理頁上方「Proposed project notes」看 diff，按「Apply to AGENTS.md」或「Reject」。`POST /api/project-notes/:id/apply` 的 body 必須是 `{}`：**沒有任何欄位可以代表擁有者同意**（issue #36 第 1 點），多帶欄位回 400。
- 筆記一律壓成一行、放在 `## Notes from Joy` 段落下的一條清單，不能新增標題或改到別的段落；超過 300 字或含機密／敏感資訊（同 T3.3 規則）拒絕。
- 套用時檔案必須與提議時一模一樣（issue #36 第 2 點）：先比對 hash；再以原子 rename 把舊檔移開、重新比對，期間有人存檔就放回原檔並回 409；新檔用 `link` 放回，若有人剛好建立同名檔案則不覆蓋。衝突的提議標成 `conflict`，檔案保持別人的版本。殘留風險：編輯器在「移開後、刪除舊檔前」對已開啟的檔案原地寫入，這段時間只有幾個系統呼叫。
- 只寫工作目錄的 `AGENTS.md`，不 commit、不推送；要不要提交由擁有者決定。
- 驗收：server 測試（助理只能提議；偽造欄位 400；套用後才寫入；別人改過的檔不覆蓋；拒絕後不能套用）、`packages/memory` 測試（檢查與替換之間被改、被建立都會偵測）、Playwright `apps/web/e2e/project-notes.spec.ts`。

### T3.4 記憶 UI

- 助理頁左側「What Joy remembers」列出全部記憶（過期、被取代的灰色標示），可編輯、刪除；每則 Joy 的回覆下方以標籤列出當時用到的記憶，按 × 即刪除。
- `PATCH /api/memories/:id`（內容 1–500 字，套用與擷取相同的敏感資訊規則，擋下回 422）、`DELETE /api/memories/:id`（204）。
- migration 10：`conversations.memory_ids` 記錄目前大腦 session 拿到哪些記憶；`messages.memory_ids` 記錄每則回覆當時用到的記憶。
- **刪除或編輯一條記憶時，所有拿過它的對話 session 都會結束**，下一輪重新開 session、只帶目前有效的記憶（resume 的 session 裡還留著舊內容，不能沿用）。回覆進行中剛好被刪除時，回覆完成後也不保留該 session。背景擷取把舊記憶標成被取代時同樣處理。
- 驗收：server 測試（刪除後同一對話與新對話都不再出現；編輯後用新內容；敏感內容 422）＋ Playwright `apps/web/e2e/memory.spec.ts`。

### T3.3 記憶擷取

- 每輪對話後，背景模型（`roles.background`）判斷擁有者這則訊息有沒有值得長期記住的事；**只把擁有者本人的訊息交給它**，助理的回覆、工具結果、任務內容都不會送進去，所以別人寫的文字種不進記憶。
- 寫入規則（`packages/memory`，**擁有者待審**）：只寫 user scope、來源 `user_utterance`；redactor 認得的機密與身分證號、卡號、密碼、健康、財務一律擋下（不信任模型的判斷，寫入前再檢查一次）；信心低於 0.6 不存；重複不存；暫時性的事（模型標記或含「這週」「目前」等字）14 天後過期；與既有記憶矛盾時舊的標成被取代、保留紀錄、不再使用；模型編造的 id 忽略。
- 新的對話 session 開始時，最多 20 條有效記憶放進助理的指示，並記錄使用時間。
- issue #39：memories 改用穩定的整數主鍵 `seq`，全文索引綁定它；`VACUUM` 後搜尋仍對到正確的記憶（測試）。
- `GET /api/memories`（不含敏感與已刪除的）。

### T3.2 派工

- 助理多了 `create_task`（預設 review_loop，也可 single）與 `cancel_task`；建立與取消和 UI 共用同一段驗證（允許清單、可改檔等）。
- 任務記住建立它的對話（migration 8 `origin_conversation_id`，對話刪除時自動解除）；任務結束時，助理在那段對話留言回報結果（通過／輪數用完待決定／失敗原因／取消）。Telegram 啟用時另外推播。
- UI 對話頁每 5 秒更新，看得到主動回報。

### T3.1 助理對話

- 大腦依 `roles.assistant_brain`（預設 OpenAI API 的小模型），可換成 Claude 或 Codex。工具只在 server 定義一次：API 大腦以 function calling 使用；CLI 大腦透過新的 `joy_assistant` MCP 橋接（`packages/tools/src/assistant.ts`，啟動時向 server 取工具清單，呼叫時轉回 server；每輪一組只限本機的 token）。
- 每段對話記住大腦與 session，下一輪接續同一個 session；換了大腦就改帶最近 20 則訊息。CLI 大腦以唯讀模式、在私有的 `~/.joy/assistant` 目錄執行。
- 目前工具都是唯讀：`list_repos`、`list_tasks`、`task_status`。建立任務等派工工具在 T3.2。
- 訊息存進資料庫前先遮罩；失敗的一輪會記成 system 訊息並回 502。OpenAI 大腦受月預算保護。
- API：`GET/POST /api/conversations`、`GET /api/conversations/:id`、`POST /api/conversations/:id/messages`。UI 新增「Assistant」頁。
- 驗證：server 測試（API 大腦以 function calling 呼叫工具並接續 session、CLI 大腦經橋接列出並呼叫工具、錯誤 token 403、失敗記錄、遮罩）。尚未用真實模型測試。

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

| 項目                                                        | 審查方式                   | 結論       | 發現                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #73 本機 API／WebSocket token                               | 獨立審查（非作者）         | 通過       | Windows 上 token 檔只依賴使用者資料夾的預設 ACL，T4.4 實機確認                                                                                                              |
| #54 GitHub publisher                                        | 獨立審查                   | 已修       | 內容掃描認不得私鑰與 AWS／Slack／Google／Stripe／GitLab 憑證 → 已加入 Redactor；**publisher 從未接到 server/UI → 新增 T1.9b**                                               |
| #57 provider 允許清單                                       | 獨立審查                   | 通過       | —                                                                                                                                                                           |
| #58 core 介面、機密遮罩                                     | 獨立審查                   | 通過       | —                                                                                                                                                                           |
| #62 `joy doctor` 鑰匙圈                                     | 獨立審查                   | 通過       | 只查詢隨機、不存在的帳號                                                                                                                                                    |
| #84 權限規則                                                | 擁有者已審（2026-11-06）   | 通過       | —                                                                                                                                                                           |
| T2.7b、T2.4a、T2.4b                                         | `/code-review`（high）     | 已修 9／10 | 見下                                                                                                                                                                        |
| T3.3 記憶寫入規則（`packages/memory`）                      | **待擁有者審**             | —          | 什麼會被記住、什麼一定擋下；agent 不審自己訂的規則                                                                                                                          |
| T3.5 專案記憶寫入（`packages/memory/src/project.ts`）       | **待擁有者審**             | —          | Joy 會寫進 repo 的內容與衝突處理；issue #36 的兩點已照驗收條件實作                                                                                                          |
| T4.2 Web Push 金鑰（鑰匙圈新 secret `web_push_vapid_keys`） | **待擁有者審**（機密處理） | —          | 金鑰只在本機產生、存鑰匙圈；推播內容經遮罩與加密                                                                                                                            |
| T3.6、T3.7、T3.9、T2.1                                      | `/code-review`（high）     | 已修 9／10 | compete 同時選擇／合併的競態、合併中重啟卡住、合併無時間上限、通知誤寫成審查未過、排程器關閉時未處理的 rejection；**未修：cron 補跑逐次計算（只在啟動時跑一次，成本有限）** |

`/code-review` 的發現與處理：重啟時等待核准的任務會卡住（已修）；核准紀錄的 detail 未遮罩（已修）；同任務多個待核准時狀態被提早改回（已修）；Telegram 群組中任何人可按核准（已修，只接受擁有者本人的私訊）；同步決定要等到逾時才生效（已修）；UI 每個事件都重抓待核准清單（已修）；沒有 token 時每分鐘警告（已修，只警告一次）；完成通知未遮罩（已修）；命名與重複程式（已修）；**Telegram 設定要重啟才生效（未修，留待之後）**。

## 需要擁有者處理

- T0.4 Codex 真實 fixture／app-server 聯調：在擁有者已登入且可執行 Codex CLI 的 Mac 錄製，指令 `node scripts/record-fixtures.mjs codex`；以真實 fixture 重跑 contract test，並在 Joy 上驗證 app-server 連線及事件／額度互通。不要在一般測試或 CI 呼叫真實模型。
- T1.9 真實驗收（擁有者 Mac）：使用該 Mac 上既有的 GitHub CLI 登入；啟動 Joy，對測試 repo 跑完一個小任務後按 Changes 欄的「Open draft PR」（第一次會要求填 GitHub repository URL），確認遠端測試分支、標題以 `[test] ` 開頭的 draft PR 與 review 摘要正確；驗收後關閉測試 PR 並刪除測試分支。不提供、不貼上或索取 PAT。
- T1.13/T1.8（擁有者 Mac）：審查 PR #62 的鑰匙圈可用性探測後，在目標 Mac 執行 `pnpm joy doctor`，確認首頁顯示該機器的 CLI、鑰匙圈與資料目錄檢查；此驗收不讀取或提供已存憑證。
- T2.4 Telegram（**擁有者決定暫緩**）：在 @BotFather 建 bot，對它傳一則訊息後用 `https://api.telegram.org/bot<token>/getUpdates` 查自己的 chat id；在 Joy 設定頁填入 chat id 與 bot token（或用環境變數 `JOY_TELEGRAM_BOT_TOKEN`），重啟 Joy。不要把 token 貼在對話、文件或程式碼中。
- T4.5：在 Mac 上 `pnpm joy container-build`、`pnpm joy container-login claude`，Docker Desktop 開啟 host networking，對一個標成 container 的測試 repo 跑一個小任務（haiku、low effort）。
- T4.9：在一台新電腦（或新使用者帳號）照 README 從 clone 到跑完第一個任務，記錄花了多久與卡住的地方。
- T4.6：Claude Code 已更新到 2.1.319 以上時，在已登入的 Mac 依 `docs/cli-versions.md` 重錄 fixture 並更新測過範圍（用 haiku、low effort）。
- T2.6 GitHub issue 真實驗收（擁有者 Mac）：確認 `gh auth status` 已登入；在測試 repo 建一個 issue 並加上 `joy` label，5 分鐘內 Joy 應建立 `#編號 標題` 的任務（標示 external content）；驗收後關閉 issue。不提供、不貼上或索取 PAT。
- T3.8 Google：完成所選 MCP server 所需的 Google 登入；登入前保持唯讀功能未連線，登入指令依該 server 文件記錄於此。
- Windows 實機驗收（P4）：在 Windows 電腦執行 `pnpm install --frozen-lockfile` 與 `pnpm check`，並依 T4.4 完成一次跨模型任務；不以 CI 取代實機驗收。

## 剩下未完成的票與原因（2026-11-06 盤點）

每張都試過能否在雲端容器內完成；以下是查證過、需要擁有者才能往下的部分。

| 票                  | 狀態                                                          | 為什麼停在這裡                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4.1 遠端存取       | 程式完成、CI 全綠，**PR 開著等審**                            | AGENTS.md：擴大到 127.0.0.1 以外須經擁有者審查。功能預設關閉                                                                                                                                                                          |
| T4.2 PWA + Web Push | 未做                                                          | 依賴 T4.1；手機上的 service worker／推播需要 HTTPS（例如 `tailscale serve` 的憑證），且驗收要在擁有者手機上                                                                                                                           |
| T4.3 Tauri 桌面版   | 擁有者決定延後（2026-11-07）                                  | 驗收是 macOS／Windows 安裝檔可安裝、更新、移除：需要 Apple Developer ID 與公證、Windows 簽章憑證、更新簽章金鑰與發佈位置，以及「安裝檔如何附帶 Node 與 Joy」的決定。容器可裝 Linux 的 webkit 套件，但無法產生或驗證這兩個平台的安裝檔 |
| T4.4 Windows 實機   | 程式完成（Windows CI 驗證 `.cmd` 啟動）                       | 驗收要在 Windows 實機跑一次交叉審查                                                                                                                                                                                                   |
| T4.9 使用者文件     | README 與 `pnpm joy start` 完成                               | 驗收要在新電腦照 README 實測 15 分鐘                                                                                                                                                                                                  |
| T0.4／T1.8／T1.13   | 程式已在 main                                                 | 需在擁有者已登入的 Mac 錄製或驗收                                                                                                                                                                                                     |
| T3.8 Google         | 未做                                                          | 需要擁有者完成 Google 登入                                                                                                                                                                                                            |
| P5（T5.1–T5.7）     | T5.6 已完成（擁有者 2026-11-07 指定）；其餘擁有者決定暫不開始 | PLAN 標明「第 24 週以後，視使用情況決定」；T5.1 要律師、T5.2 要安裝 CLA app（改 repo 設定，擁有者規定不改）、T5.3／T5.7 要雲端帳號與費用、T5.4 依賴 T4.1、T5.5 要 LINE 帳號與費用確認                                                 |

## 卡住

- 無。
