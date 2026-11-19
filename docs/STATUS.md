# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-19（助理對話可以附圖片與文字檔：圖片隨訊息交給大腦、文字檔引用進訊息，存下的訊息只留擁有者的話並列出檔案；migration 28 讓附件屬於任務或對話其中之一，分支 `assistant-attachments`）
- 最後更新：2026-11-19（介面：審查卡與 Joy 工具改用易懂的名稱、側邊欄篩選顯示各狀態數量並把目前條件留在清單上方、任務／對話／設定都有自己的網址（上一頁、下一頁可用），分支 `ui-improvements`）
- 最後更新：2026-11-19（T0.4 Codex 真實 fixture（exec 的 edit／mcp／resume）與 contract test、確認 app-server 設定警告是 `configWarning`＋`warning` 兩則同文字；T4.6 重錄 Claude 2.1.319 fixture，錄製腳本清掉 init 事件裡擁有者的外掛／連接器／skills；Codex exec 搭附件真實通過；review loop 也會提示「說改了沒改」；分支 `claude/codex-verify-e95d1a`）
- 最後更新：2026-11-19（真實 CLI 第四輪：一律允許、附件、專案 hooks 同意、Codex exec 都通過；「說改了沒改」的提示在任務完成收合後仍留在外面，沒有變更時按鈕改成「清除工作副本」並不再要 GitHub 網址，分支 `keep-warning-visible`）
- 最後更新：2026-11-19（真實 CLI 第三輪：審查看到檢查結果、說改了沒改的提示、auto 權限、換 provider 交接與重做、合併到 main 與開編輯器都通過；修 Claude 多輪 run 的 token 只算最後一輪，分支 `claude-usage-turns`）
- 最後更新：2026-11-19（`queue-rewind` 的測試改成等 agent 開始才送要排隊的訊息，修掉 macOS／Windows CI 上偶爾失敗；分支 `fix-queue-rewind-flaky`）
- 最後更新：2026-11-19（審查依據實際檢查結果：審查者 prompt 一律寫出 Joy 跑了什麼（指令、結束碼、截斷遮罩後的輸出結尾）或沒跑什麼，審查者維持唯讀；分支 `review-verification`）
- 最後更新：2026-11-19（執行訊號：實作者說改了檔案但沒有變更時提示一行、Codex 設定警告每次執行只報一次且不當錯誤、權限選單說明 Codex 沙盒差異，分支 `run-signals`）
- 最後更新：2026-11-19（競賽裁判輸入瘦身：裁判 run 不載入 Claude 內建工具、skills、CLAUDE.md，prompt 的 diff 有上限與註記；新增 core 選填欄位 `RunOptions.promptOnly` 待擁有者審；分支 `judge-input`）
- 最後更新：2026-11-19（Codex 只拿 Joy 給的 MCP：關掉擁有者的 config.toml server、外掛、連接器與遠端外掛；修 `codex exec resume` 的 `--sandbox`；分支 `codex-approvals-reviewer`）
- 最後更新：2026-11-19（真實 CLI 第二輪：steer、換模型 resume、compete 通過；修掉 Codex 沿用擁有者 `approvals_reviewer` 讓自己的審查子代理繞過 Joy 核准的問題；分支 `codex-approvals-reviewer`）
- 最後更新：2026-11-19（真實 CLI 冒煙測試：review loop 兩種組合都通過；修好 Claude 在連結資料夾下回報絕對路徑；擁有者確認 core 與 policy 已審；分支 `real-cli-smoke`）
- 最後更新：2026-11-19（完成的任務可「合併到 main」（本機合併，先確認分支與檔案數）與「在編輯器開啟」（設定 `editor`），分支 `task-actions`）
- 最後更新：2026-11-19（介面與 bug 修正：輸入框依自身寬度收合、加入專案讀出 repo 的預設分支與 GitHub origin 並在加入時檢查分支、環境檢查文字改給使用者看、首頁指出選的模型缺哪個 CLI、手機任務頁不重複標題；本檔只留近期驗證結果，較早的移到 `docs/status-history.md`；分支 `ui-fixes`）
- T2.1 平行競賽已用假 provider 完成；擁有者 Codex 額度恢復後可用真實 CLI 跑一次（最便宜模型、low effort）。T3.8 需要 Google 登入，未做。
- 目前階段：P1 真實驗收由擁有者在本機處理；P2 按 T2.3 → T2.7b → T2.4 → T2.5 → T2.1 執行，完成後依序進入 P3。

## 最近變更

- 2026-11-18（修掉 `thread-api` 兩個排隊訊息測試在 CI 上偶爾失敗：送達紀錄比 provider 下一次呼叫早寫入，測試改成兩者都等到，分支 `fix-thread-api-flaky`）
- 2026-11-18（加入專案對話框：家目錄還在載入時開始編輯路徑（例如全選再貼上），載入結果不再蓋掉輸入框；修掉 CI 上 `t1.8` 偶爾失敗，分支 `folder-dialog-race`）
- 2026-11-17（專案 `.claude/settings.json` 會自己執行的指令（hooks 等）要擁有者同意才啟動 Claude，內容變了再問，migration 27，分支 `project-hooks`）
- 2026-11-17（e2e 的埠改用 `JOY_E2E_WEB_PORT`／`JOY_E2E_API_PORT` 設定，本機跑 e2e 不用再改檔，分支 `e2e-ports`）
- 2026-11-17（安全缺口：Claude 不再載入 `.claude/settings.local.json`、設定頁把 http MCP 設成唯讀前要確認、同一個 JOY_HOME 只能有一個 Joy，分支 `security-gaps`）；2026-11-17（外掛：輸入框 `/` 叫出 skill、`@` 插入專案檔案與 MCP server，設定 → 外掛可新增 MCP server（stdio／http，機密只在 keychain），分支 `plugins`，**`packages/core` 的 `McpServerConfig.approval`、`packages/policy` 的 MCP／Skill 規則與 `packages/secrets` 的 MCP 機密待擁有者審**）

更早的「最後更新」紀錄在 `docs/status-history.md`。

## 擁有者待審

- **2026-11-19 擁有者確認：`packages/core` 介面與 `packages/policy` 的待審項目都沒問題**（下表與各節標「core／policy 待擁有者審」的都算已審）。其他類別仍待審：`packages/secrets` 的 MCP 機密、channel 認證、記憶寫入規則。

2026-11-06 由 agent 代為審查（擁有者授權）。下表為結論；擁有者可只看「發現」欄。

| 項目                                                                                                                                                                                                                         | 審查方式                             | 結論       | 發現                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #73 本機 API／WebSocket token                                                                                                                                                                                                | 獨立審查（非作者）                   | 通過       | Windows 上 token 檔只依賴使用者資料夾的預設 ACL，T4.4 實機確認                                                                                                                                                                                                          |
| #54 GitHub publisher                                                                                                                                                                                                         | 獨立審查                             | 已修       | 內容掃描認不得私鑰與 AWS／Slack／Google／Stripe／GitLab 憑證 → 已加入 Redactor；**publisher 從未接到 server/UI → 新增 T1.9b**                                                                                                                                           |
| #57 provider 允許清單                                                                                                                                                                                                        | 獨立審查                             | 通過       | —                                                                                                                                                                                                                                                                       |
| #58 core 介面、機密遮罩                                                                                                                                                                                                      | 獨立審查                             | 通過       | —                                                                                                                                                                                                                                                                       |
| #62 `joy doctor` 鑰匙圈                                                                                                                                                                                                      | 獨立審查                             | 通過       | 只查詢隨機、不存在的帳號                                                                                                                                                                                                                                                |
| #84 權限規則                                                                                                                                                                                                                 | 擁有者已審（2026-11-06）             | 通過       | —                                                                                                                                                                                                                                                                       |
| T2.7b、T2.4a、T2.4b                                                                                                                                                                                                          | `/code-review`（high）               | 已修 9／10 | 見下                                                                                                                                                                                                                                                                    |
| T3.3 記憶寫入規則（`packages/memory`）                                                                                                                                                                                       | **待擁有者審**                       | —          | 什麼會被記住、什麼一定擋下；agent 不審自己訂的規則                                                                                                                                                                                                                      |
| T3.5 專案記憶寫入（`packages/memory/src/project.ts`）                                                                                                                                                                        | **待擁有者審**                       | —          | Joy 會寫進 repo 的內容與衝突處理；issue #36 的兩點已照驗收條件實作                                                                                                                                                                                                      |
| T4.1 遠端存取（`remote` 設定、token 重新產生、`packages/server`）                                                                                                                                                            | 已審（2026-11-07）                   | —          | 預設關閉；開啟前請確認只填 Tailscale IP，並看過 Host／Origin 與 401 的處理                                                                                                                                                                                              |
| T4.2 Web Push 金鑰（鑰匙圈新 secret `web_push_vapid_keys`）                                                                                                                                                                  | **待擁有者審**（機密處理）           | —          | 金鑰只在本機產生、存鑰匙圈；推播內容經遮罩與加密                                                                                                                                                                                                                        |
| T3.8 外部 MCP 工具的動作分類（`packages/server/src/external-mcp.ts`）                                                                                                                                                        | **待擁有者審**（等同權限分類）       | —          | 不改 policy 規則，但哪些 Google 工具算「讀」「自己的行程」「寄信／邀請」由這裡決定；不認得的一律要核准                                                                                                                                                                  |
| 本機 listener 接受自己的 Origin（`packages/server/src/server.ts` 的 `originAllowed`，2026-11-13）                                                                                                                            | 擁有者已審（2026-11-14）／通過       | —          | 只在連到本機 listener 的埠、對端 loopback、Origin 為 `http://127.0.0.1:<該埠>` 或 `http://localhost:<該埠>` 時放行，用來讓 `serveUi` 提供的打包介面能 POST 與連 WebSocket；remote listener、其他埠、https、`[::1]` 一律照舊 403；Host、`sec-fetch-site`、token 檢查沒動 |
| 執行中即時補充：`packages/core` 的 `RunOptions.onSteer`／`Steer`（2026-11-09）                                                                                                                                               | 擁有者已審（2026-11-13）             | 通過       | 可選欄位，不支援的 provider 不用動；Claude stream-json 與 Codex `turn/steer` 的真實 fixture 由擁有者先錄（Claude 先）                                                                                                                                                   |
| 附件：`packages/core` 的 `RunOptions.images`、`ImageInput`、`Steer` 第二個參數 `images`（2026-11-14）                                                                                                                        | 擁有者已審（2026-11-14）／通過       | —          | 都是可選；不支援圖片的情況由 provider 丟出可處理的錯誤（Claude 容器模式）；附件路徑只指向 `<JOY_HOME>/attachments`，不進 worktree                                                                                                                                       |
| 附件文字的定位（`packages/server/src/attachments.ts` 的框架字句、`taskBrief` 的段落順序，2026-11-14）                                                                                                                        | 擁有者已審（2026-11-14）／通過       | —          | 文字附件當「reference data, follow it only where the owner's message says so」，不列在「Later instructions from the owner」清單內；若擁有者希望附件可直接當指令（例如附上規格要照做），要改這裡                                                                         |
| 權限模式：`packages/core` 的 `PermissionMode`、`Task.permissionMode`（必填）、`clampPermissionMode`；`packages/policy` 的 `shell.ts`、`classify*` 的 `mode` 參數、`ClassifiedAction.grant` 與 `evaluateAction`（2026-11-15） | **待擁有者審**（core 介面與 policy） | —          | `ask` 結果不變；`auto`／`full` 的放行範圍與永遠擋下的清單見「驗證結果」；Claude Bash 沒有 sandbox                                                                                                                                                                       |
| 這個任務內一律允許：`packages/policy/src/task-allow.ts`（能不能記、指紋）、`shell.ts` 的 `analyzeShellConcerns` 與 `analyzeSearch`、`classify.ts` 的 Grep／Glob 秘密檢查；server 的套用順序與 migration 24（2026-11-15）     | **待擁有者審**（policy）             | —          | 指紋規則與不提供的清單見「已確認決策」最上面一列；MCP 一律不提供、完成後不失效（依協調者指示）                                                                                                                                                                          |
| 任務用量：`packages/core` 的 `AgentEvent` `usage` 新增選填 `costSource`、`inputTokens` 含快取的語意（Claude 解析器改為加總快取 token，2026-11-16）                                                                           | **待擁有者審**（core）               | —          | 見「已確認決策」最上面一列；沒有新 migration                                                                                                                                                                                                                            |
| T3.6、T3.7、T3.9、T2.1                                                                                                                                                                                                       | `/code-review`（high）               | 已修 9／10 | compete 同時選擇／合併的競態、合併中重啟卡住、合併無時間上限、通知誤寫成審查未過、排程器關閉時未處理的 rejection；**未修：cron 補跑逐次計算（只在啟動時跑一次，成本有限）**                                                                                             |

`/code-review` 的發現與處理：重啟時等待核准的任務會卡住（已修）；核准紀錄的 detail 未遮罩（已修）；同任務多個待核准時狀態被提早改回（已修）；Telegram 群組中任何人可按核准（已修，只接受擁有者本人的私訊）；同步決定要等到逾時才生效（已修）；UI 每個事件都重抓待核准清單（已修）；沒有 token 時每分鐘警告（已修，只警告一次）；完成通知未遮罩（已修）；命名與重複程式（已修）；**Telegram 設定要重啟才生效（未修，留待之後）**。

## 需要擁有者處理

- 這個任務內一律允許（2026-11-15）：(1) 審 `packages/policy/src/task-allow.ts`、`analyzeShellConcerns`、`analyzeSearch` 與 `classify.ts` 的 Grep／Glob 秘密檢查（見「擁有者待審」；後者在 `ask` 模式也會讓碰到秘密的搜尋改成要問）；(2) 確認依協調者指示定的兩點：MCP 工具一律不提供、只在封存／丟棄／刪除時失效（完成後的 follow-up 沿用）；(3) 用 haiku 跑一個 `ask` 任務，在核准卡按「這個任務內一律允許」，確認同一指令不再問、改參數會問，並在 ⋯ 選單撤銷。
- 權限模式（2026-11-15）：(1) 審 `packages/core` 的 `PermissionMode`／`Task.permissionMode` 與 `packages/policy/src/shell.ts`、`classify.ts` 的 auto／full 規則（見「擁有者待審」）；(2) 用 haiku 跑一個 `auto` 的 review_loop 任務，確認 `pnpm install … && pnpm check` 不再要核准、`curl` 仍要；(3) 決定是否要在 Claude Code 開啟它自己的 Bash sandbox（需要先做 spike）。
- 附件（2026-11-14）：(1) 審 `packages/core` 的 `RunOptions.images`、`ImageInput`、`ImageMediaType` 與 `Steer` 的第二個參數，以及文字附件的定位（見「擁有者待審」）；(2) 確認上限（3.75 MiB 圖片、256 KB 文字、每任務 40 個與 100 MB、每次 run 8 張圖與 256 KB 文字、容器 64 KB 文字）、「PDF 不收」、審查者看附件、草稿保存 id 這幾個決定；(3) 在已登入的 Mac 錄 fixture（haiku／gpt-6-luna、low effort）：Claude `-p --input-format stream-json` 第一則訊息帶一張小 PNG、Codex app-server `turn/start` 帶 `localImage`、`codex exec --image`、`codex exec -`（prompt 從 stdin）；錄完把合成 fake 換成真實 fixture。
- 不用終端機（2026-11-13 起）：先 `brew install node@22`（服務需要長期存在的 Node 22），然後在 Joy 資料夾 `pnpm joy build-ui`、`pnpm joy service install --dry-run` 看過內容、再 `pnpm joy service install`；完整步驟見 README「不用終端機」。要確認：登入後 Joy 自己啟動、`http://127.0.0.1:4317` 開得起來、Chrome 能安裝成 App、`pnpm joy service uninstall` 乾淨移除。這台 Mac 上的 launchd 行為（含 `PATH` 讓服務找得到 `claude`／`codex`）只有擁有者實機能驗證。
- Claude 真實 fixture：擁有者先錄（`node scripts/record-fixtures.mjs claude`，更新 `TESTED_CLI_VERSIONS`）；之後做 T1.13 與 T1.9 驗收。
- T0.4 Codex 真實 fixture／app-server 聯調：在擁有者已登入且可執行 Codex CLI 的 Mac 錄製，指令 `node scripts/record-fixtures.mjs codex`；以真實 fixture 重跑 contract test，並在 Joy 上驗證 app-server 連線及事件／額度互通。不要在一般測試或 CI 呼叫真實模型。
- T1.9 真實驗收（擁有者 Mac）：使用該 Mac 上既有的 GitHub CLI 登入；啟動 Joy，對測試 repo 跑完一個小任務後按 Changes 欄的「Open draft PR」（第一次會要求填 GitHub repository URL），確認遠端測試分支、標題以 `[test] ` 開頭的 draft PR 與 review 摘要正確；驗收後關閉測試 PR 並刪除測試分支。不提供、不貼上或索取 PAT。
- T1.13/T1.8（擁有者 Mac）：審查 PR #62 的鑰匙圈可用性探測後，在目標 Mac 執行 `pnpm joy doctor`，確認首頁顯示該機器的 CLI、鑰匙圈與資料目錄檢查；此驗收不讀取或提供已存憑證。
- T2.4 Telegram（**擁有者決定暫緩**）：在 @BotFather 建 bot，對它傳一則訊息後用 `https://api.telegram.org/bot<token>/getUpdates` 查自己的 chat id；在 Joy 設定頁填入 chat id 與 bot token（或用環境變數 `JOY_TELEGRAM_BOT_TOKEN`），重啟 Joy。不要把 token 貼在對話、文件或程式碼中。
- T4.5：在 Mac 上 `pnpm joy container-build`、`pnpm joy container-login claude`，Docker Desktop 開啟 host networking，對一個標成 container 的測試 repo 跑一個小任務（haiku、low effort）。
- T4.9：在一台新電腦（或新使用者帳號）照 README 從 clone 到跑完第一個任務，記錄花了多久與卡住的地方。
- T4.6：Claude Code 已更新到 2.1.319 以上時，在已登入的 Mac 依 `docs/cli-versions.md` 重錄 fixture 並更新測過範圍（用 haiku、low effort）。
- T2.6 GitHub issue 真實驗收（擁有者 Mac）：確認 `gh auth status` 已登入；在測試 repo 建一個 issue 並加上 `joy` label，5 分鐘內 Joy 應建立 `#編號 標題` 的任務（標示 external content）；驗收後關閉 issue。不提供、不貼上或索取 PAT。
- T3.8 Google：依 README「Google 行事曆與 Gmail」建立 Google Cloud OAuth 用戶端（Desktop app），執行一次 `uvx workspace-mcp --tools gmail calendar` 完成登入，在 `config.yaml` 加上 `mcp_servers.google`；然後問助理「明天下午有空嗎」，並試一次寄信確認要核准。
- Windows 實機驗收（P4）：在 Windows 電腦執行 `pnpm install --frozen-lockfile` 與 `pnpm check`，並依 T4.4 完成一次跨模型任務；不以 CI 取代實機驗收。

## 剩下未完成的票與原因（2026-11-06 盤點）

每張都試過能否在雲端容器內完成；以下是查證過、需要擁有者才能往下的部分。

| 票                  | 狀態                                                          | 為什麼停在這裡                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4.1 遠端存取       | 已合併（PR #110），擁有者已審                                 | AGENTS.md：擴大到 127.0.0.1 以外須經擁有者審查。功能預設關閉                                                                                                                                                                          |
| T4.2 PWA + Web Push | 未做                                                          | 依賴 T4.1；手機上的 service worker／推播需要 HTTPS（例如 `tailscale serve` 的憑證），且驗收要在擁有者手機上                                                                                                                           |
| T4.3 Tauri 桌面版   | 擁有者決定延後（2026-11-07）                                  | 驗收是 macOS／Windows 安裝檔可安裝、更新、移除：需要 Apple Developer ID 與公證、Windows 簽章憑證、更新簽章金鑰與發佈位置，以及「安裝檔如何附帶 Node 與 Joy」的決定。容器可裝 Linux 的 webkit 套件，但無法產生或驗證這兩個平台的安裝檔 |
| T4.4 Windows 實機   | 程式完成（Windows CI 驗證 `.cmd` 啟動）                       | 驗收要在 Windows 實機跑一次交叉審查                                                                                                                                                                                                   |
| T4.9 使用者文件     | README 與 `pnpm joy start` 完成                               | 驗收要在新電腦照 README 實測 15 分鐘                                                                                                                                                                                                  |
| T0.4／T1.8／T1.13   | 程式已在 main                                                 | 需在擁有者已登入的 Mac 錄製或驗收                                                                                                                                                                                                     |
| T3.8 Google         | 未做                                                          | 需要擁有者完成 Google 登入                                                                                                                                                                                                            |
| P5（T5.1–T5.7）     | T5.6 已完成（擁有者 2026-11-07 指定）；其餘擁有者決定暫不開始 | PLAN 標明「第 24 週以後，視使用情況決定」；T5.1 要律師、T5.2 要安裝 CLA app（改 repo 設定，擁有者規定不改）、T5.3／T5.7 要雲端帳號與費用、T5.4 依賴 T4.1、T5.5 要 LINE 帳號與費用確認                                                 |

## 卡住

- 無。

## 驗證結果

> 2026-11-15 以前的驗證結果在 `docs/status-history.md`。

### 助理對話附件（2026-11-19，分支 `assistant-attachments`，基於 `ui-improvements`）

- **改動**：`POST /api/conversations/:id/messages` 接受 `attachments`（上傳流程、型別與大小上限和任務相同；每則 ≤ 10 個，每個對話 ≤ 40 個、≤ 100 MB）。圖片用 `RunOptions.images` 交給助理大腦（OpenAI API、Claude、Codex 三種大腦都已支援圖片），文字檔用任務同一套框架字句引用進這一輪的訊息。訊息仍要有文字。
- **存什麼**：`messages` 只存擁有者打的字；檔案用 `attachments.conversation_id` 與 `message_id`（`messages` 的 id）連到那則訊息，`GET /api/conversations/:id` 在使用者訊息上列出 `attachments`。記憶擷取、對話摘要、標題都只看擁有者打的字，不看檔案內容。不能續用 session 的大腦（第一輪或換了大腦）從歷史只拿到檔名。
- **DB**：migration 28 加 `attachments.conversation_id`（`ON DELETE CASCADE`，`CHECK` 不能同時屬於任務與對話）；「還沒用過」改成兩個欄位都是 NULL，所以送進對話的檔案不能再給任務用，反之亦然，也不會被清理掉。送出後移除（`DELETE /api/attachments/:id`）同任務：留下名稱、標成已移除。
- **網頁**：助理輸入框多了迴紋針、貼上與拖放（沿用任務的 `useAttachments`）；送出的訊息顯示縮圖或檔名。
- **驗證**：db `attachments.test.ts` +1；server `attachments-api.test.ts` 把原本「助理只收文字」的測試換成兩個（大腦收到圖片與引用的文字、存下的訊息不含檔案內容、重複送出 409、移除後標成已移除；任務與對話不能共用同一個檔案）；e2e `attachments.spec.ts` +1。用假資料預覽把 `assistant_brain` 設成假的 `claude-cli`，貼上一張圖片送出：訊息上有縮圖，網址從 `?chat` 換成 `?chat=<id>`。
- **沒驗證到**：真實大腦（haiku／luna／OpenAI API）看圖的回答；Telegram 送來的圖片不在這次範圍。

### 介面：工具名稱、篩選、網址（2026-11-19，分支 `ui-improvements`）

- **工具名稱**：Claude 用 `--json-schema` 回結構化結果時的 `StructuredOutput` 工具呼叫改顯示「送出結果」；Joy 自己的 MCP 工具（`mcp__joy__ask_peer`、`task_status`、`request_approval`、`approve`）改顯示中文動作名（`tool-calls.ts`）。其他 MCP 工具照舊顯示短名。
- **側邊欄篩選**：狀態篩選原本就有（最近項目的漏斗），這次在每個選項旁顯示會列出幾個任務（依目前選的專案計算，`statusCounts`）；篩選中時清單上方有一個標籤寫出條件（例如「沒完成 · beta」），點一下就清除。
- **網址**：網址列跟著目前頁面走：`?task=<id>`、`?chat=<id>`（新對話是 `?chat`）、`?settings=<section>`（專案可加 `&repo=<id>`），新任務頁是 `/`。用 query string 而不是路徑，因為 server 只在 `/` 提供網頁，通知原本就開 `/?task=<id>`。上一頁、下一頁會換頁；新對話拿到 id、在設定裡切換分頁時改寫目前這一筆而不新增，所以一次上一頁就離開設定。開啟時網址不認得就換成 `/`（`route.ts`）。`SettingsSection` 型別改從 `route.ts` 的清單來，兩邊不會不同步。
- **驗證**：`tool-calls.test.ts`、`sidebar-groups.test.ts`、`route.test.ts` 新增測試；e2e `sidebar-projects.spec.ts` 加上數量、清除標籤，以及網址、上一頁、下一頁、直接開連結的測試。用假資料預覽（`joy-fake-preview`）在深色桌面寬度點過：點任務網址變成 `?task=…`、上一頁回到前一個任務、篩選標籤顯示「已完成」。
- **沒驗證到**：手機寬度與淺色模式沒截圖；真實審查者的 `StructuredOutput` 只用單元測試確認。

### 真實 CLI 驗證第五輪：Codex fixture、Claude 重錄、exec 附件、review loop 提示（2026-11-19，分支 `claude/codex-verify-e95d1a`）

本機 Mac、codex-cli 0.166.0、Claude Code 2.1.319；模型一律 gpt-6-luna／haiku、effort `low`。擁有者的 Joy（:4317）與 `~/.joy` 沒動。

- **T0.4 Codex 真實 fixture**：`node scripts/record-fixtures.mjs codex` 錄到 `edit`、`mcp`、`resume-1`、`resume-2`，四個都結束碼 0。`parse.test.ts` 加了對應的 contract test，都通過。實測到的事：
  - 擁有者的 `config.toml` 有過時的 `features.goal`，每次 `exec` 開頭都有兩則一樣的 `item.completed {type: error}` 設定警告；parser 只報一次 `status`，沒有 `error`。
  - luna 用 `sed` 改檔，**沒有 `file_change` item**；Joy 靠 worktree diff 判斷，不受影響。
  - `-c mcp_servers.joy.*` 注入的 MCP 在 `exec` 可用（`ask_peer` 回 `PEER SAYS: 4`）。`exec` 沒有互動式核准，`--sandbox workspace-write` 下 `rm math.js` 直接成功。
  - `codex exec resume` 用同一個 thread id，答得出 PELICAN。
  - 錄製沒有隔離擁有者的 Codex 設定，所以 input tokens 很大（edit 15 萬）；fixture 只測事件格式，不影響。
- **app-server 設定警告的通知名稱**：用腳本啟動真實 `codex app-server`，只送 `initialize` 和 `thread/start`（沒有 turn，不花額度）。實際收到兩則：`initialize` 後一則 `configWarning {summary, details: null}`，`thread/start` 後一則 `warning {threadId, message}`，文字相同（`generate-json-schema` 也只有這兩個名稱）。`app-server-parse.ts` 原本就接這兩個，兩則會合併成一則 `status`，所以不用改程式；`config-warning.test.ts` 補了這個真實形狀的測試。
- **T4.6 Claude 重錄**：`node scripts/record-fixtures.mjs claude` 用 2.1.319 錄了四個 fixture，contract test 不用改就通過；`TESTED_CLI_VERSIONS.claude` 改成 2.1.319（`doctor.test.ts`、`server.test.ts` 的版本跟著改）。**repo 是公開的**，而這次的 `system/init` 列出擁有者的外掛（含私人 marketplace 名稱）、已連接的 claude.ai 連接器和它們的工具、skills、agents。錄製腳本現在會清掉這些：只留 `joy` MCP、`mcp__joy__*` 工具和 `@builtin` 外掛，skills／slash_commands／agents 清空，scratchpad／socket／記憶路徑／啟動計時換成 `<SCRUBBED>`。Joy 從 init 只讀 session id、model、版本、權限模式、MCP 清單和工具數。`node scripts/record-fixtures.mjs claude --scrub` 可以對已錄的檔案重新清一次，不會呼叫模型。
- **Codex exec 搭附件**：暫存 `JOY_HOME`、port 4421、`providers.codex.transport: exec`。single 任務附一張 16×16 藍色 PNG 和 `notes.txt`（代號 OSPREY），luna 回「color: blue; codeword: OSPREY」，沒有用工具，任務 `done`。Codex 的 session 紀錄是 `originator: codex_exec`；圖片從 `<JOY_HOME>/attachments/<id>.png`（worktree 外）以 `input_image` 送進去，文字檔內嵌在 prompt 裡。
- **review loop 的「說改了沒改」**：`result.warning {reason: empty_diff_claimed_changes}` 原本只在 single 模式。現在 review loop 也會判斷，條件是：最後一次寫程式的實作者回合（round ≥ 1，計畫回合不算）成功、整個 run 沒有 `file_change`、結果沒有變更、回覆說有改。提示在 `result` 之前送出。沒有變更時 review loop 本來就以「The implementer made no changes」失敗，這則提示用來說明：模型說它改了，但其實沒改。新測試在修正前失敗（`server.test.ts`，single 與 review_loop 各一，另有一個不該提示的情況）。
- `pnpm check` 通過（134 個測試檔、1612 個測試）。
- **沒驗證到**：app-server 跑完整個 turn 時的設定警告（只看到 turn 前那兩則）、`turn/steer` 的真實事件、Windows 原生（T4.4）、容器內的 `exec --image`。Codex 的 `synthetic-edit` fixture 保留，因為真實錄製裡沒有 `file_change`、`todo_list` 和失敗的指令，provider 測試還要靠它。

### 真實 CLI 驗證第四輪（2026-11-19，分支 `keep-warning-visible`）

設定和第三輪一樣：暫存 `JOY_HOME`、port 4420、所有角色都用 haiku 或 gpt-6-luna，effort `low`。

- **這個任務內一律允許**：`ask` 模式下，第一次 `node test.js` 選「這個任務內一律允許」，會記下 `task_allow.created {kind: shell, target: "node test.js"}`；之後同一個指令不再問，`node --no-warnings test.js` 會問。用 `DELETE /allows/:id` 撤銷後，下一輪的 `node test.js` 又會問。專案的 `checkCommand` 走 Joy 自己的檢查流程，在 `ask` 模式每輪都會問，也不提供一律允許。
- **附件**：上傳一張 16×16 紅色 PNG 和一個 `notes.txt`（內容是代號）。Claude haiku 和 Codex luna（app-server）都答「color: red; codeword: HERON」，沒有用任何工具。
- **專案 hooks 同意**：`.claude/settings.json` 裡放一個 `SessionStart` hook，執行時把一行字寫進標記檔。四個情況都符合預期：
  - 拒絕：Claude 沒有啟動，任務失敗並說明原因，標記檔不存在。
  - 核准：hook 執行一次。
  - 下一個任務：不再問，hook 照樣執行。
  - 改了 hook 內容並 commit 之後：會再問一次。
- **Codex exec 模式**（`providers.codex.transport: exec`）：luna 說「已修正 math.js」，但沒有任何變更，Joy 出現 `result.warning`。接續時用的是同一個 session id，也答得出代號 KESTREL。exec 模式下 luna 不會真的改檔，和以前手動跑的結果一樣，是 CLI 本身的行為。
- **畫面（假資料預覽與暫存 Joy，深色與淺色、桌面與手機寬度）**：檢查卡、每輪用量那一行、審查卡、合併到 main、重做都正常。找到兩個問題並修好：
  - 任務完成後「過程」會收合，「agent 說改了檔案，但沒有任何變更」原本也會被收進去。現在時間軸的 step 多了 `notice` 標記，收合時會留在外面（`fold.test.ts`）。
  - 沒有任何變更的任務原本會顯示紅色的「丟掉這些變更」和 GitHub 網址欄位。現在改成次要的「清除工作副本」，也不再要 GitHub 網址（`components/task-panels.test.tsx`）。
  - 兩個測試在修正前都失敗。修正後我用 Vite 開發伺服器接到暫存 Joy，在手機寬度、淺色模式下截圖確認。
- **觀察（沒改）**：審查者呼叫結構化輸出的步驟會顯示工具原名 `StructuredOutput`；網頁沒有網址路由，任務頁沒有自己的網址。
- **沒驗證到**：Windows；Codex exec 搭附件（`codex exec --image`）。

### 真實 CLI 驗證第三輪（2026-11-19，分支 `claude-usage-turns`）

暫存 `JOY_HOME`、port 4420、暫存 repo（`math.js` 加 `node test.js`）；所有角色都設成 haiku／gpt-6-luna、`low`。

- **審查看到檢查結果（#164）**：review_loop，`checkCommand: ["node","test.js"]`，任務要求「測試和 `npx eslint .` 都要過」。`checks` 事件有 `command`、結束碼 0、`ok add`；審查者摘要寫出 `node test.js` 通過，並說 `npx eslint .` 不在 Joy 的驗證結果裡、沒有確認。審查者沒有自己跑指令。
- **說改了檔案其實沒改（#163）**：haiku 照指示只回「I fixed the bug in math.js…」、不改檔，出現一次 `result.warning {reason: empty_diff_claimed_changes}`。
- **`auto` 權限模式**：`pnpm install && pnpm test` 不用核准；`curl -sI https://example.com` 要核准（`run_outside_worktree`），拒絕後實作者沒有改用其他方式重試，並在回覆說明。這個暫存 repo 沒有 `.gitignore`，`pnpm install` 產生的 `node_modules`、`pnpm-lock.yaml` 進了 diff，被審查者擋下後實作者自己清掉（repo 設定問題，不是 Joy 的）。
- **換 provider 交接**：haiku 跑完第一輪後，訊息帶 `roleOverrides.implementer = gpt-6-luna`。產生 `task.settings.handoff {from: claude-cli/haiku, to: codex-cli/gpt-6-luna}` 與新的 attempt；luna 答出第一輪記住的代號與改過的檔案。
- **重做第一輪**：`POST /rewind {messageId: "task"}` 改寫 prompt 後，`task.rewound` 記下捨棄的訊息與 `savedAs` 檢查點，新的一輪從原始狀態做出新 diff（多了 `// rewound`）。
- **合併到 main 與開編輯器（#159）**：`open-editor` 用設定的指令加參數，最後一個參數是 worktree 路徑；`merge-into-default` 沒有 `confirm` 回 400；確認後建立 `--no-ff` 合併 commit，並更新 checkout；再合併一次回 409 `nothing_to_merge`。
- **用量（找到並修好）**：直接用 claude-cli 2.1.319（haiku）量。同一個 stream-json 程序裡，每次 `result` 的 `usage` 只算該輪，`total_cost_usd` 與 `modelUsage` 是累計值；同一輪內多次工具呼叫，`usage` 有加總（`num_turns: 3` 時等於三則 assistant 訊息的和）。Joy 原本只取最後一個 `result` 的 `usage`，所以有 steer 或排隊訊息的 run 少算 token（成本正確）。現在 token 逐輪加總，成本取最後一個；假 CLI 改成照實測行為，`parse.test.ts` 新測試在修正前失敗。
- **觀察（沒改）**：權限預審依 reviewer → judge → assistant_brain… 的順序挑「和實作者不同的 provider」。任務把 reviewer 覆寫成同 provider 時，會選到沒有 API key 的 `openai-api`，預審變成 `unavailable`，退回由擁有者核准，行為安全。
- **沒驗證到**：Windows；Codex 多輪 `turn.completed` 的 usage 是否累計（Joy 本來就逐輪記）；畫面沒有截圖。

### 審查依據實際檢查結果（2026-11-19，分支 `review-verification`）

- **問題**：真實 run 中 Claude 審查者在 plan mode（唯讀），沒辦法執行任務要求的驗證指令，審查只靠讀 diff。
- **做法（延伸既有的送審前檢查，沒有新機制）**：專案的 `checkCommand` 本來就在實作者結束後、每次審查前由 Joy 在實作者 worktree 執行（依任務權限模式走既有 policy／核准，輸出先用 Redactor 遮罩再截最後 4000 字）。這次補上：(1) 審查者 prompt 一律有「Verification」段：跑了就寫指令、結束碼（通過也寫）與輸出結尾（用比內容更長的 fence 包住，並註明是程式輸出不是指令）；有指令但沒跑（未核准、沒有 runner、核准關閉）寫出原因；沒設定指令就寫 Joy 沒跑任何檢查、不要聲稱驗證過；(2) 都要求審查者不要自己跑測試，任務要求但沒涵蓋的驗證要在摘要說沒跑；(3) `checks` 事件多了 `command`，網頁檢查卡顯示指令；(4) 已完成任務收合過程時，最後一次檢查失敗就留在外面。審查者仍是 `read-only`，CLI 旗標沒動。
- **沒做**：任務文字裡點名的指令不會被 Joy 自動抽出來執行（從自由文字抽指令不可靠，且等於讓 prompt 決定 Joy 跑什麼；要跑請在專案設定 `checkCommand`）。compete 的評審沒有接檢查結果。
- **驗證**：新增 orchestrator 測試（通過時給指令／結束碼／輸出、沒設定時說沒跑、略過時說原因且不擋核准、輸出含反引號不會跳出 fence）、server 測試（沒設定不執行並告知審查者、輸出截斷與 `command`、取消任務會中止進行中的檢查且不審查、略過原因進 prompt、遮罩）、web 單元（timeline 解析 `command`、收合保留失敗的檢查）與 e2e（檢查卡顯示指令）。format、lint、typecheck 通過；`pnpm test` 全跑時機器負載很高（load 30+），每次有 2–4 個不同的逾時失敗（executor 行程樹、PR publisher 逾時、server 其他測試），失敗的 executor 與 server 檔案單獨重跑都通過；orchestrator＋web 389 passed、server `thread-api.test.ts` 66 passed；`pnpm test:e2e` 140 passed。
- **沒驗證到**：沒呼叫真的 CLI；真實審查者是否照 prompt 在摘要標明未驗證的部分沒跑過。

### 執行訊號（2026-11-19，分支 `run-signals`）

- 單一模式的實作者成功結束、工作副本沒有任何變更、沒有 `file_change` 事件，但最後訊息像在說改了檔案（提到檔案路徑或「修正／fixed／updated」等字）時，記一筆 `result.warning` 事件，討論串顯示一行「agent 說改了檔案，但沒有任何變更」；任務結果不受影響。判斷在 `packages/server/src/empty-change-claim.ts`。review loop 路徑尚未加。
- Codex 的「忽略 1 個無法辨識的設定」通知（`~/.codex/config.toml` 有過時的 key）改成每次執行只發一次 `status`，不再是兩筆 recoverable `error`（`config-warning.ts`，exec 與 app-server 解析器共用；app-server 的通知方法名 `configWarning`／`warning`／`error` 是依協定推測，尚未用真實輸出確認）。
- 權限選單「要求核准」的說明加上 Codex 在沙盒內不問、出沙盒才問。

### 競賽裁判輸入瘦身（2026-11-19，分支 `judge-input`）

真實 run（裁判 Claude haiku、low）兩個一行 diff 就用了約 44.5k input token，遠多於實作者。

- **token 去哪了（程式分析，未用真實 CLI 量）**：裁判 prompt 本身很小（兩個一行 diff 約 700 字元，約 170 token；最壞 60k 字元）。其餘是 Claude Code 自己每次 run 都帶的：內建工具定義、系統提示，以及 `--setting-sources user,project` 載入的使用者與專案 CLAUDE.md、skills 清單。裁判沒有掛 MCP（`--strict-mcp-config`），也沒有核准工具。裁判在 repo 本身（不是 worktree）唯讀執行，這些工具它既用不到也看不到 attempt 的檔案。
- **改動**：`RunOptions` 新增選填 `promptOnly`（**`packages/core` 介面，待擁有者審**）；裁判 run 傳 `promptOnly: true`（仍是 `read-only`、沒有 MCP、沒有核准工具）。Claude provider 對它加 `--tools ""`、`--disable-slash-commands`，並把 `--setting-sources` 改成空字串（不載入 CLAUDE.md、skills、user／project hooks）；其他 provider 忽略它，Codex 沒動。其他角色（實作者、審查者）參數不變。
- **prompt**：diff 總量上限 `JUDGE_DIFF_CHARS = 40_000`（原本 `MAX_DIFF_CHARS` 60k），短的 diff 整份保留、剩餘額度給長的（原本平均分，短 diff 浪費額度）；被截斷的 attempt 會列出完整的「Changed files」清單與「diff cut: first N of M characters」註記（不再叫它「read the files」，裁判沒有工具）；審查摘要上限 2000 字元。prompt 明說沒有工具。合併（`mergePrompt`）不變。
- **裁判輸出**：結構化輸出與判斷邏輯不變；若後端沒給 structured output 但 finalMessage 是 JSON（含 code fence），也接受。
- **量測**（`judgePrompt` 字元數，前→後）：兩個一行 diff 634→699（多一句「沒有工具」）；200k + 5k 的兩個 diff 35,563→40,691（原本 A 只拿 30k、B 的額度用不完；新上限下 A 拿 35k）；兩個都超大最壞 60k→40k。
- **測試**：`compete.test.ts`（裁判 run 收到 `read-only`、`promptOnly`、無 `mcpServers`／`approvalTool`／resume；小 diff prompt 小、大 diff 有上限、註記與檔案清單；純文字 JSON 答案）、`claude-cli/args.test.ts`（promptOnly 的參數，一般 run 不變）。
- **沒驗證（需要真實 CLI）**：實際 input token 降多少；`--tools ""` 搭 `--json-schema` 是否仍能回結構化輸出（若不行，上面的純文字 JSON 退路會接住，但值得跑一次確認）；裁判結論品質。驗證方式：compete 任務裁判用 haiku／low 跑一次，看 `compete.usage` 的 input token。
- **真實 CLI 實測（2026-11-19，協調者補）**：haiku `low` 當裁判、兩個一行 diff：input tokens 44,502 → **6,203**、US$0.18 → **US$0.029**；`--tools ""` 搭 `--json-schema` 仍回結構化判斷，`/choose` 正常。觀察：沒有載入 CLAUDE.md，英文任務的判斷理由是英文。

### 真實 CLI 驗證第二輪：steer、換模型 resume、Codex 升權、compete（2026-11-19，分支 `codex-approvals-reviewer`）

同樣用暫存 `JOY_HOME`、埠 4420 的另一個 Joy，經 API 跑，模型都是 `haiku`／`gpt-6-luna`、`low`（換模型那一步用 `sonnet` `low`）。

- **執行中即時補充（steer）**：Claude 實作者在 `sleep 20` 時收到訊息，`delivery: steer`、`user.message.delivered via steer`。整個任務只有 1 次 provider run、1 個結果，diff 同時有修正和插話要求的 `// steered`。
- **Claude 換模型後 resume**：第一輪 haiku，follow-up 帶 `roleOverrides.implementer = sonnet`。兩輪是同一個 session id，模型從 `claude-haiku-5-5` 變成 `claude-sonnet-5-5`，第二輪答出第一輪要它記住的暗號。
- **Codex 跨出沙盒（找到並修好安全問題）**：`ask` 模式下要 Codex 跑 `curl -sSI https://example.com`。修正前沒有任何核准就連上網路（`HTTP/2 200`）。原因是擁有者的 `~/.codex/config.toml` 設了 `approvals_reviewer = "guardian_subagent"`，codex-cli 0.166.0 的 app-server thread 沿用它（`thread/start` 回應 `approvalsReviewer: "auto_review"`、`networkAccess: false`），升權請求由 Codex 自己的審查子代理批准，Joy 的模式與秘密規則都被繞過。修法：`thread/start`／`thread/resume` 一律送 `approvalsReviewer: 'user'`，`codex exec` 加 `-c approvals_reviewer="user"`（exec 沒人可問，升權就被拒）。修正後實跑：請求以 `run_outside_worktree` 核准卡送到 Joy，核准才執行；拒絕則不執行，Codex 回報「升級權限請求遭拒」。測試：`app-server.test.ts`（start 與兩種 resume 都帶 `approvalsReviewer`）、`args.test.ts`（read-only／workspace-write 都帶），修正前失敗。
- **compete**：Claude haiku 對 Codex luna、裁判 haiku。兩邊各自完成、互審都核准，裁判給出 `winner` 與理由，任務停在 `review_ready`（`awaitingChoice`）；`POST /choose` 後 `compete.chosen`、另一份 `discarded`，任務 `done`。觀察：裁判一次用了 44,502 input tokens、沒有快取命中，約 US$0.18，比實作者貴很多。
- **compete 的「請裁判合併」**：`POST /merge` 後 `compete.merge_started`，裁判（haiku）在第三個 worktree 重新實作，Codex 審查核准，`compete.merged`，任務回到等待選擇（「合併版好了」）；`/choose` 選合併版後 `compete.chosen`、兩份原始方案 `discarded`，任務 `done`。第二次裁判有快取命中（25,992），約 US$0.08。
- **Codex 的 MCP 提問**：擁有者加的 stdio MCP server（`scripts/fixtures/mcp-stub.mjs`）在 `ask` 模式下，Codex 呼叫 `ask_peer` 時發 `mcpServer/elicitation/request`，Joy 出核准卡（`toolCall: true`、寫出 server 自己的訊息），核准後工具才跑並回傳 `PEER SAYS: 4`。
- **Codex 會載入擁有者全域的 MCP（已修）**：Joy 的 Codex run 原本會啟動擁有者 `~/.codex/config.toml` 的全部 MCP server（實測 9 個，含 `computer-use`、`node_repl`、`private_investment_*`）、外掛帶的 server（CapCut、Notion、Gmail…）、`codex_apps` 連接器與遠端外掛的 server；Codex 曾呼叫 `mcp__capcut_creation_resource__background_music`，沒有送任何核准到 Joy。修法（等於 Claude 的 `--strict-mcp-config`）：app-server 以 `--disable plugins --disable apps --disable remote_plugin` 啟動（遠端外掛在 thread 層關太晚，實測要在啟動時關）；`config/read` 讀出生效的 `mcp_servers` 名稱，`thread/start`／`thread/resume` 把不屬於 Joy 的都設 `enabled: false`；thread 開好後 `mcpServerStatus/list`，還有非 Joy、非 disabled 的 server 就在任何 turn 之前結束這次 run；`config/read` 失敗也不跑（交給 exec 退路）。`codex exec` 加 `--ignore-user-config --ignore-rules --disable plugins --disable apps --disable remote_plugin`。實跑：同一個 MCP 任務只啟動 `joy` 與 `stub`，Codex 直接用 `stub`。測試：`app-server.test.ts` 3 個（停用與啟動旗標、漏網 server 在 turn 前停下、`config/read` 失敗不開 thread）、`args.test.ts`，修正前都失敗。
- **順手修：`codex exec resume` 不接受 `--sandbox`**（codex-cli 0.166.0 回 `unexpected argument`），Joy 原本照送，exec 退路的接續一定失敗。改成 `-c sandbox_mode="…"`（`args.test.ts` 新測試，修正前失敗）；真實 `provider.e2e`（app-server 與 exec、各自修 bug 後 resume）兩個都通過。
- **已知缺口：擁有者的 Codex execpolicy 規則**：`~/.codex/rules/default.rules` 的 `decision="allow"` 規則在 app-server 仍有效。實測 `ask` 模式下 `curl -sS --max-time 2 -I https://example.com`（符合一條 allow 規則）不問 Joy 就連網執行。app-server 沒有 `--ignore-rules`（`ignoreRules` 只在管理者的 `AutoReviewRequirements`），唯一辦法是另給一個沒有 rules 的 `CODEX_HOME`，那會牽動登入憑證的位置，違反「不碰訂閱憑證」，所以沒做。和 Claude 一樣（擁有者自己 `~/.claude/settings.json` 的 allow 規則也不經 Joy），視為擁有者自己的設定；`codex exec` 已加 `--ignore-rules`。專案 `.codex/rules`（repo 自帶的規則）在 app-server 是否生效沒有驗證。
- **沒驗證到**：Windows。

### 真實 CLI 冒煙測試（2026-11-19，分支 `real-cli-smoke`）

用本機登入的 Claude Code 2.1.319（`haiku`）與 codex-cli 0.166.0（`gpt-6-luna`、`low`）實跑，花費很少（Claude 一次約 US$0.005）。

- **provider 層**：`JOY_E2E_CLAUDE=1 JOY_E2E_CODEX=1 pnpm vitest run --project providers provider.e2e`。新增 `codex-cli/provider.e2e.test.ts`（app-server 與 exec 兩種模式、不退回 exec、修 bug 後 resume）。
- **找到並修好**：Claude 回報檔案用**真實路徑**，工作目錄經過連結時（macOS 的 `/var` → `/private/var`），`file_change` 原本顯示絕對路徑。`ClaudeStreamParser.relPath` 改成也用 `cwd` 的真實路徑比對（`parse.test.ts` 新測試，修正前失敗）。
- **Codex exec 的發現**：`codex exec` 搭 `gpt-6-luna` 會說「已修正」但只跑過 `cat`，不經 Joy 直接執行也一樣；app-server（Joy 預設）會真的修改。exec 只是 app-server 起不來時的退路，測試裡 exec 只驗證接線。
- **全流程**：另開一個 Joy（暫存 `JOY_HOME`、埠 4420，不碰擁有者的 Joy）從 API 跑 review loop：(1) Claude 實作＋Codex 審查、`auto`：18 秒完成，第 1 輪核准，diff 為 `math.js` +1 −1；(2) Codex 實作＋Claude 審查、`ask`，並要求實作者自己跑 `node -e` 驗證：24 秒完成，第 1 輪核准。
- **觀察（符合現有設計，沒改）**：`ask` 模式下 Codex 在沙盒內執行 `rg`、`cat`、`node -e` 都沒有問擁有者，因為三種模式都用 `workspace-write`＋`on-request`，只有跨出沙盒才問（`app-server.ts` 的註解）。Claude 審查者在 plan mode 裡，沒辦法執行任務要求的驗證指令，它在審查摘要裡自己說明了這點。
- **沒跑到**：執行中即時補充（steer）、Claude `--resume` 換模型、Codex 跨出沙盒的核准往返、compete。擁有者的 Claude 5 小時額度當時已用到約 90%，所以先停在這裡。

### 任務完成後：合併到預設分支、在編輯器開啟（2026-11-19，分支 `task-actions`）

- **合併**：`POST /api/tasks/:id/merge-into-default`（body 一定要 `{ "confirm": true }`；`/merge` 已是 compete 的「裁判綜合」）。只有 `done` 且沒在跑的任務；compete 只合併擁有者選的方案。先用 publisher 同一個 `executor.commit` 把工作副本提交到任務分支，再由 `WorktreeExecutor.mergeIntoDefaultBranch`（`packages/executor/src/merge.ts`）合併。一律 `--no-ff`：任務是一個可用 `git revert -m 1` 撤回的 merge commit。hooks 指向空資料夾、不簽章、明確帶 `--commit --no-squash --no-autostash` 蓋過擁有者的 `mergeOptions`。成功記 `task.merged`（branch、commit、sourceCommit、files），時間軸顯示「已合併到 main」，按鈕消失，直到 agent 又做了新一輪。
- **安全規則**（拒絕時一律 409、帶 `reason`，任何東西都沒動，連任務的 commit 都還沒做）：預設分支在 `repo.path` checkout 中 → 有已追蹤檔案的未提交變更（`dirty_checkout`）或進行中的 merge／rebase／cherry-pick／bisect（`operation_in_progress`）就拒絕；未追蹤檔案交給 git 自己保護。預設分支沒被 checkout → 只在 fast-forward 時用 `commit-tree`＋`update-ref`（帶舊值做 compare-and-swap）建 merge commit，不碰擁有者的工作目錄，否則 `not_fast_forward`。預設分支在別的 worktree → `checked_out_elsewhere`。已經合併過、或沒有變更 → `nothing_to_merge`。衝突 → `git merge --abort`（失敗再 `reset --merge` 回原 HEAD），回 `reason: conflict` 與 `conflicts` 檔案清單。
- **編輯器**：`POST /api/tasks/:id/open-editor`，設定 `editor: { command: code, args: [] }`（`packages/config`），執行 `command [...args, worktree]`，`shell: false`、detached。路徑只來自 Joy 的 attempt 紀錄，且必須在 Joy 的 worktrees 資料夾裡、還存在、沒被移除，否則 404。找不到指令回 422 `reason: editor_not_found`，UI 顯示「找不到 code 指令，請在設定指定編輯器」。放在 ⋯ 選單。
- **前端**：完成列下方「合併到 main」→ 行內確認「把 N 個檔案合併到 main？」→ 合併／取消；拒絕原因用中文顯示（衝突列出檔名）。合併後「丟掉這些變更」變成「清除工作副本」（變更已在 main，直接帶 `confirmUnpushedCommits`）。
- **測試**：executor `merge.test.ts`（11 個：乾淨合併、main 已前進仍可合併、main 有未提交變更、進行中的 merge、衝突中止、未 checkout 的 FF 與非 FF、別的 worktree、第二次合併、沒有變更、hooks 不執行）；server `task-actions.test.ts`（8 個：`confirm` 必填、合併與 `task.merged`、第二次 409、dirty、衝突、非 FF、執行中、編輯器參數、預設 `code` 找不到、404 三種）與 `editor.test.ts`；config `editor` 預設與驗證；web `task-actions.test.ts`、`timeline.test.ts`；Playwright `task-actions.spec.ts`（確認流程、已合併狀態、衝突文字、沒變更不顯示、選單項目與錯誤）。
- **驗證**：本機 `pnpm check` 的 format、lint、typecheck 通過，vitest 1566 passed、1 失敗是既有的 `thread-api`「continues a single task right after the run…」在全套並行時逾時，單獨重跑 63 個全過。e2e 在臨時埠（4399／4398）137 個全過。
- **沒驗證到**：沒有真的開過 VS Code；Windows 上 `code` 是 `code.cmd`，不經 shell 無法執行，要在設定填編輯器的 `.exe`；Windows／Linux 的合併只靠 CI。

### 介面與 bug 修正（2026-11-19，分支 `ui-fixes`）

- **輸入框溢出**：輸入框改用 container query（`container: composer`），依自己的寬度而不是視窗寬度收合。1024px 視窗、側邊欄與 diff 面板都開著時，任務頁輸入框只有 272px，原本模型選單溢出到 diff 面板、被送出鈕壓住；現在做法與權限只剩圖示，模型名稱用省略號。
- **加入專案的預設分支**：新增 `GET /api/fs/repository?path=`（沿用資料夾選擇器的禁區規則），回傳 `origin/HEAD` 指向且本機存在的分支，否則目前 checkout 的分支，以及 `origin` 是 github.com 時的 HTTPS 網址（帶帳密的 URL 不採用）。對話框選了 git 專案就自動帶入分支。`POST /api/repos` 對 git repo 檢查分支存在（`refs/heads/<name>^{commit}`），不存在回 422，對話框顯示「這個專案沒有「x」分支」；沒給 `githubRemote` 時自動用偵測到的 GitHub origin。非 git 路徑照舊不檢查（既有測試與 API 用法）。
- **環境檢查文字**：CLI 版本不在測試範圍時，改說「通常仍可使用；出現無法解讀的輸出時改裝測試過的版本 x.y.z」，不再叫使用者重錄 fixture；鑰匙圈正常時說「Joy 可以使用系統鑰匙圈保存機密」。
- **缺 CLI 的提示**：首頁選的實作者（review loop／compete 加上審查者）需要的 CLI 被環境檢查判定缺少時，橫幅改成「找不到 Claude Code CLI，選這個模型的任務無法執行」，點了到環境檢查。
- **手機寬度**：任務頁的頂列不再重複任務標題（任務標題列就在下面）。
- **本機 `pnpm check`**：`.prettierignore` 排除 `graphify-out/`。
- **測試**：server `folders.test.ts`（master 分支、origin/HEAD 優先、GitHub SSH 轉 HTTPS、GitLab 與帶帳密不採用、非 repo 409、`branchExists` 拒絕 `-` 開頭）與 `sidebar-api.test.ts`（偵測、錯分支 422、自動帶 GitHub origin）；e2e `sidebar-projects`（自動帶 master、錯分支的提示）、`doctor`（缺 CLI 橫幅）、`task-diff-allow`（1024px 下工具列不溢出，修正前失敗）。`t1.8` 的測試 repo 原本 `git init` 沒有 commit、沒有 `main`，現在會被擋，改成有一個 commit。
- **順手修的測試**：`thread-api`「leaves discarded messages out of what the reviewer is told later」只等到 `running` 就送訊息，全套負載下會趕上第一個 prompt（單獨跑與 main 上都過），改成等 agent 開始；`origin-proxy` 選的「其他埠」是 Web 埠＋1，用 `JOY_E2E_WEB_PORT=4401 JOY_E2E_API_PORT=4402` 時剛好是 API 自己的埠（伺服器信任），改成避開 API 埠與 5173。
- **驗證**：`pnpm check` 通過（vitest 1545 passed、4 skipped；server 專案連跑兩次 426 passed）；e2e 在 4401／4402 136 個全過。用假 runtime 實際看過 1024px 任務頁：工具列不再溢出。
- **沒驗證到**：真實家目錄下的 repo（多 remote、detached HEAD）只靠單元測試；Windows 沒跑。

### 修正偶爾失敗的 `thread-api` 測試（2026-11-18，分支 `fix-thread-api-flaky`）

- **原因**：`messages queued when a limit stops the task` 裡「按 Continue 會送出」與「review loop 也一樣」兩個測試，等到 `user.message.delivered` 就去讀 `claude.calls[1]`；但送達紀錄是在 provider 第二次呼叫之前寫的，負載重時（#156 的 Windows CI）讀到 `undefined`。
- **修法**：`until` 的條件改成送達與 `claude.calls` 都到齊才往下；斷言沒放寬，伺服器程式沒改。
- **驗證**：這組 10 個測試連跑 5 次都通過；format（只檢查 git 追蹤的檔案，本機 `graphify-out/` 不在 CI）、lint、typecheck 通過，vitest 1540 passed、4 skipped。這是時序問題，沒有在本機重現失敗。

### 安全缺口：settings.local.json、唯讀 http MCP、同一個 JOY_HOME（2026-11-17，分支 `security-gaps`）

- **Claude 的設定來源**：每個 run 都加 `--setting-sources user,project`。用 2.1.319＋haiku 實測（細節在 `docs/spikes/claude-code.md`「權限與審核」）：`-p` 下 worktree 是沒信任過的資料夾，專案 `.claude/settings.json` 的 allow 規則會被 CLI 忽略，但 **`.claude/settings.local.json` 的 allow 規則與 hooks 照樣生效**，repo 提交這個檔就能不經 Joy 執行指令。加了旗標之後，local 不再載入；專案 CLAUDE.md、`.claude/skills`、`.claude/commands` 都還在（`user` 或空字串會連這些一起拿掉，所以不用）。`acceptEdits` 下 agent 用 Write 寫 `.claude/settings.json` 會交給 Joy 核准，不會直接寫入。
- **Codex 的 session 紀錄**：用假的機密值實測 codex-cli 0.166.0（`-c mcp_servers.*.env` 與 `http_headers`），整個 `~/.codex`（含 sessions 與 sqlite）都找不到那個值；rollout 只記 `session_meta`、`turn_context`（模型、cwd、sandbox、核准設定）。這次額度用完，回合沒跑完，走的是 `exec` 而非 app-server（兩者共用同一套設定與 rollout 程式）。
- **唯讀的 http MCP**：設定 → 外掛把 http server 勾成唯讀（新增或之後勾）前，跳出確認並寫出主機名稱：auto 模式下它的工具不會先問，agent 給的內容會直接送過去。取消就不送出。stdio server 不問。
- **同一個 JOY_HOME**：`createJoyServer` 一開始用 `lockHome(<home>/joy.lock)`（`packages/db`）拿獨佔鎖，第二個 Joy 在碰任何東西前就停下，訊息是 `Another Joy is already running with this home folder …`。用 SQLite 的 `locking_mode = EXCLUSIVE` 而不是 pid 檔：程式怎麼結束（含 `SIGKILL`）鎖都由作業系統釋放，不會留下殘鎖，pid 被重用也不會擋住啟動。啟動失敗或 `close()` 都會釋放。
- **測試**：providers `args.test.ts`（三種 autonomy 都在 `--` 之前帶 `user,project`）；db `home-lock.test.ts`（同時只有一個、release 後可再拿、持有的子程序被 `SIGKILL` 後可再拿）；server `server.test.ts`（同時啟動兩個只成功一個、關掉後下一個可用同一個 token 啟動）；web `plugins.test.ts`（`readOnlyRisk`）與 Playwright `plugins.spec.ts`（http 唯讀取消就不送、確認才送）。原本「兩個 server 同時啟動共用一個 token」的測試改成上面這個，因為現在不允許兩個同時跑；`retains the runtime allowlist guard` 改成只算啟動後的設定讀取（`createJoyServer` 現在先拿鎖，啟動時讀設定的時間點晚了一步）。
- **驗證**：`pnpm check` 通過（server 單獨跑兩次 405 passed；全套並行時 `queue-rewind` 的重啟測試曾失敗一次，單獨與 server 專案重跑都通過，和 `thread-api` 一樣是負載下的時序）。e2e 在臨時埠 130 個通過，`t1.8`、`origin-proxy` 2 個是換埠造成的既有失敗。
- **仍存在**：repo 自己提交的 `.claude/settings.json` 的 hooks 每個 run 都會執行（等於加入這個 repo 就信任它；拿掉 `project` 會失去專案 skill 與 CLAUDE.md）；使用者 `~/.claude/settings.json` 的 allow 規則是擁有者自己的設定，照樣不經 Joy。

### 外掛：`/` skill、`@` 檔案與 MCP、設定 → 外掛（2026-11-17，分支 `plugins`，**core、policy、secrets 待擁有者審**）

- **輸入框**：訊息開頭打 `/` 列出實作者這個 CLI 的 skill 與自訂指令（Claude：`~/.claude/skills`、專案 `.claude/skills`、`commands/*.md`；Codex：`~/.codex/skills`、`~/.agents/skills`、專案 `.agents/skills`；Codex 的 prompts 只在互動 TUI 展開，不列），以及 Joy 自己的指令；`@`（開頭或空白後）列出專案的 MCP server 與 git 認得的檔案（`git ls-files` 含未追蹤、不含忽略的，模糊比對，插入相對路徑）。方向鍵、Enter、Esc。skill 只讀 frontmatter（`name`、`description`），不讀內容。
- **skill 怎麼送出**：server 把開頭的 `/name` 換成帶本次程式 nonce 的標記（`SkillMarkers`），provider 包裝層在送出前依 CLI 展開成它看得懂的指示；偽造或舊的標記、找不到的名稱都保持原文；外部內容（匯入的 issue）不展開。
- **MCP server**（設定 → 外掛）：migration 26 `mcp_servers`（STRICT、CHECK；名稱只能英數字 `-` `_`、不能含 `__`、不分大小寫唯一；`joy`、`joy_assistant`、`codex_apps` 不分大小寫保留）。stdio（command＋args＋環境變數）或 http（URL＋header，URL 不能帶帳密）；勾「機密」的變數值只存 OS keychain（`mcpSecretName(id, name)`），SQLite 與 API 回應只有名稱；可限定專案、停用、標成唯讀。只交給有 Tool Hub 的實作者 run（計畫、審查、peer 沒有核准管道，不給），容器專案不給。Claude 用 `--mcp-config <JOY_HOME>/mcp-run/joy-claude-*/mcp.json`（0600，run 結束刪除，server 啟動時只清掉殘留的 `joy-claude-*`、失敗只警告；容器 run 只把這個檔案唯讀掛進去；**不放系統暫存資料夾**，那裡 agent 可以不經詢問讀取）；Codex app-server 從 stdin 的 JSON-RPC 拿設定，並設成每次呼叫都要問；`codex exec` 遇到要每次問的 server 就整個略過。
- **權限（policy）**：owner 加的 MCP 工具每種模式都問（full 也不給 grant），不提供「這個任務內一律允許」。標成唯讀的 server 只在 **auto** 不問，而且只限**這次 run 實際拿到**的 server（run 開始時固定，缺機密被略過的不算，`RunGrants` 以工作副本路徑為 key）；ask、full、外部內容都照問。Codex 只有 `_meta.codex_approval_kind === 'mcp_tool_call'` 的 elicitation 能套用唯讀，其他 server 的提問一律交給擁有者，核准卡寫出 server 自己說的工具名與訊息（不受信任，最多 200 字）。`Skill`／`SlashCommand`：只有擁有者這一輪用 `/name` 叫出的 skill 不問（使用者與專案都有同名的 skill 時不放行，因為不知道 CLI 會載入哪一個；同一個工作副本裡沒有 Tool Hub 的 run，例如 peer、pre-review，不會動到實作者的授權），其他每種模式都問（skill 的 `allowed-tools` 會讓 CLI 不經 Joy 就執行那些工具，而 repo 或 agent 自己都能放 skill 進工作副本）。
- **審查**：Opus reviewer 審了 policy、secrets、migration、MCP 設定與機密的流向。必修兩項已修：(1) `mcp.json` 原本在 OS temp，auto／full 下 `Read`／`cat`／`Grep` 都能不經詢問讀到 → 改到 JOY_HOME；(2) `Skill` 原本每種模式都放行 → 只放行擁有者叫出的。也一起修了：名稱含 `__` 讓唯讀判斷認錯 server、保留名稱大小寫、唯讀清單依 DB 而非這次 run、Codex 非工具呼叫的 elicitation 被當成審批。
- **測試**：policy `plugins.test.ts`（MCP 各模式、唯讀只在 auto、外部內容、不提供一律允許、Codex 非工具呼叫、核准摘要、skill 只放行擁有者叫出的、`mcp.json` 路徑每種模式都問）；db `mcp-servers.test.ts`（機密不進表、壞形狀、保留名稱、`__`、大小寫唯一、繞過模組時的 CHECK）；secrets（MCP 機密名稱）；server `plugins.test.ts`（標記、排序、`RunGrants`）與 `plugins-api.test.ts`（CRUD、只給實作者、唯讀、skill 展開、外部內容不展開、檔案列表）；providers（Claude `configDir`、Codex app-server 的 MCP 設定與 elicitation）；executor `listProjectFiles`；Playwright `plugins.spec.ts`（`/` 選單、`@` 選單、設定 → 外掛）。
- **驗證**：`pnpm check` 通過（vitest 1515 passed、4 skipped；一個 `thread-api` 的時間上限測試曾在全套並行時逾時，單獨跑通過）。e2e 在臨時埠（假 runtime 4398＋Vite 4173）129 個通過；`t1.8`、`origin-proxy` 2 個失敗在 origin/main 用同樣臨時埠也失敗，是換埠造成。
- **沒驗證到**：沒有呼叫真的 CLI。Codex 的 `default_tools_approval_mode: 'prompt'` 是否真的讓每個工具呼叫都發 `mcpServer/elicitation/request`、elicitation 的真實 params（`_meta` 的鍵名是從 codex 0.166.0 的 binary 字串推得）都沒錄過；Claude 在 `-p --permission-prompt-tool` 下 skill 的 `allowed-tools` 實際行為沒驗證；使用者或 repo 的 `.claude/settings.json` 若有 `permissions.allow: ["mcp__x__*"]`，那些工具不會交給 Joy（和 Bash 一樣是既有缺口，Joy 沒傳 `--setting-sources`）；Codex 是否把 thread 設定（含機密）寫進 `~/.codex/sessions` 沒查。唯讀的 http MCP 等於 auto 下可傳任意參數的網路出口，UI 沒有特別警告。已放行的 skill 只比對名稱，agent 呼叫時帶的參數（`args`、`/name` 後面的文字）不檢查。

### 每個任務顯示用量與耗時（2026-11-16，分支 `task-usage`，基於 `queue-rewind`，**`packages/core` 的 `usage` 事件新增 `costSource` 待擁有者審**）

- **盤點**：provider 本來就會解析用量（Claude `result` 的 `usage`／`total_cost_usd`、Codex `turn.completed` 的 `usage`、OpenAI API 的 token 與價目表成本），server 本來就把 `usage` 事件記在任務事件裡，並有 `taskUsage`（總耗時、tokens、cost、依模型分）與任務選單的「用量」面板。缺的是：快取 token 沒進任務用量、沒有依角色分開、耗時含等核准的時間、沒有每輪的時間與 tokens、compete 裁判的用量不在任務裡、成本來源沒記、統計頁沒有依任務的比較。**沒有新 migration**：用量從既有事件（`events`／`task_events`）讀出，舊任務有什麼就顯示什麼。
- **資料來源（CLI 實際回報 vs 推算）**：
  - **CLI 實際回報**：Claude 的 `usage.input_tokens`／`cache_read_input_tokens`／`cache_creation_input_tokens`／`output_tokens` 與 `total_cost_usd`（fixture 的 `modelUsage[].costBasis` 是 `list`，即依標價換算，**訂閱用戶不會實際被扣**）；Codex 的 `input_tokens`／`cached_input_tokens`／`output_tokens`（Codex **沒有**回報金額，所以 Codex 的 cost 一律空白）。
  - **推算**：OpenAI API 的成本是 Joy 用設定裡的價目表乘 token（`costSource: 'price_table'`）；Claude 的 `inputTokens` 由 Joy 加總（`input_tokens` + 兩種 cache token），讓三個後端的 `inputTokens` 都是「含快取的全部輸入」，`cachedInputTokens` 是其中讀自快取的部分；耗時、每輪、每角色時間全部是 Joy 自己從事件時間戳算的 wall-clock，**不是** CLI 回報的 `duration_ms`。
  - 不在裡面：權限預審、助理（`assistant_brain`）等額外呼叫，只進每日 `usage` 表。
- **core（待審）**：`AgentEvent` 的 `usage` 新增選填 `costSource?: 'cli' | 'price_table'`，並註解 `inputTokens` 含快取。Claude 解析器的 `inputTokens` 語意因此變了（以前不含快取，現在含；`/api/usage` 的每日 `input_tokens` 之後也是含快取，舊資料不回填）。
- **server**：新檔 `packages/server/src/task-usage.ts`（純函式 `summarizeTaskUsage`，取代 `server.ts` 裡舊的 `taskUsage`）。一輪＝`started` 到第一個結束事件（`result`／`error`／`task.paused`／`interrupted`／`quota.queued`／`run.interrupted`）。輸出 `durationMs`（**不含**等核准）、`approvalWaitMs`（`approval.requested` 到 `approval.decided`，沒決定就算到這一輪結束，之後遲到的決定忽略）、tokens／cost／`costSource`（來源不同記 `mixed`）、`byProvider`（依模型）、`byRole`（實作者／審查者／裁判，各自的 tokens、cost、時間，時間也扣掉該 attempt 等核准的部分）、`runs`（每輪的 `endSeq`、耗時、tokens、cost）。模型由 `phase` 事件的 `model` 決定，實作者沒有 phase 時退回 attempt 的 provider／model。compete 的裁判以前只進每日表，現在發任務層級事件 `compete.usage`，併入任務用量與最後一輪。`GET /api/stats` 多回 `tasks`（期間內最新 50 個任務與各自的用量，不含 `runs`），db 新增 `listTasksCreated`、`listTaskEventsOfTypes`（只載入需要的事件，避開工具輸出與 diff）。
- **前端**：每一輪結尾在時間軸一行小字（例如「2 分 14 秒 · 38k tokens」，有 cost 再加「· $0.12」；tokens＝輸入＋輸出）。這行是獨立的時間軸項目，完成後收合過程時**保留**（和擁有者訊息一樣）。任務選單的「用量」面板：耗時、等核准、tokens（含「快取」）、估計花費與來源（「CLI 回報」「價目表」），下面依模型、依角色各一份；原本的說明段落拿掉。統計頁（設定 → 統計）新增「各任務用量」表：耗時、Token、花費、模型，表頭可排序，沒回報的顯示「—」。舊任務沒有 tokens／cost／runs 時都不顯示，也不報錯。
- **測試**：providers（Claude 含快取加總與無成本時沒有來源、`costSource` 兩處）；server `task-usage.test.ts`（10 個：空任務、依模型／角色／輪加總、等核准扣除與沒決定、多輪、裁判併入最後一輪、進行中與未結束、來源 mixed、非數字與壞時間）、`thread-api.test.ts`（review loop 的角色與輪、follow-up 後兩輪、`/api/stats` 的 tasks）、`server.test.ts`（compete 裁判用量）；db `stats.test.ts`（期間／repo／limit、只載入用量事件）；web `usage.test.ts`、`timeline.test.ts`（每輪行的位置、沒有時不出現、`compete.usage` 不顯示）、`fold.test.ts`（收合後保留）；Playwright `thread-api.spec.ts`（面板、每輪行與收合、舊任務）與 `stats.spec.ts`（任務比較與排序）。
- **驗證**：`pnpm check` 通過（format、lint、typecheck；vitest 1415 passed、4 skipped）。e2e 用不提交的暫時 harness（假 runtime 4402＋Vite 4177，proxy 指向 4402），跑完刪除：`stats`、`thread-api`、`task-page-cleanup`、`declutter`、`compete` 全過，整套 120 個中 118 過；2 個失敗是 harness 造成的（`origin-proxy.spec.ts` 寫死 5173，連線被拒；`t1.8.spec.ts` 存設定要 Origin 5173），與這次改動無關。
- **沒驗證到**：沒有呼叫真的 Claude Code／Codex，用量欄位只對照錄好的 fixture（Claude `result`、Codex `turn.completed`）；多輪 Claude run 的 `usage`／`total_cost_usd` 是每輪還是累計（2026-11-19 已實測並修正，見「真實 CLI 驗證第三輪」）；compete 同時有多個 attempt 等核准時，總等待時間是「任何一個在等就算等」，沒有真實並行的測試；深色與手機寬度沒看。

### 側邊欄：已釘選／專案／最近項目，加入專案選資料夾（2026-11-16，分支 `sidebar-projects`，基於 `main`）

- **側邊欄由上而下**：新任務（鉛筆圖示，回首頁輸入框）與聊聊、搜尋、「已釘選」（沒有釘選就不顯示）、「專案 ›」（可收合，標題右側「＋」加入專案）、「最近項目 ›」（可收合，標題右側篩選與新對話圖示）、設定。專案列點一下展開它的任務（預設全部收合，有任務在等你時收合的專案列顯示小點），列尾 ⋯ → 設定，直接開設定頁「專案」且只顯示這個專案（有「所有專案」按鈕回到全部）。取代 #146 的依專案分組（`groupByProject` 與 `joy.sidebar.collapsed.v1` 移除）。搜尋、等你的標示、封存在設定裡都保留；搜尋時各區塊都展開，沒有符合的專案不顯示。收合與展開的狀態存 localStorage 的 `joy.sidebar.v2`（`{collapsed, open}`，每次讀寫都 try/catch，壞掉的值視為沒有記憶）。
- **釘選存在 server**：migration 25（只新增，排在 #147 的 24 之後）：`tasks.pinned_at`、`conversations.pinned_at`（TEXT，NULL＝沒釘，CHECK 不可為空字串）。`PATCH /api/tasks/:id` 多收 `pinned: boolean`（至少要給 title、archived、pinned 其中一個）；新增 `PATCH /api/conversations/:id` `{pinned}`。釘選**不動 `updated_at`**（最近項目的排序依它）；重複釘選保留第一次的時間；封存會取消釘選，已封存的任務不能釘（409），取消封存不會恢復釘選。回應與列表多 `pinnedAt`（沒釘就沒有這欄）。已釘選區依釘選時間新到舊，釘選的項目不再出現在「最近項目」（專案展開裡還是會有）。每一列的 ⋯ 選單：釘選／取消釘選、封存（取代原本 hover 的封存按鈕，名稱 `更多：標題`）。
- **最近項目篩選**：狀態（全部／等你的／進行中／已完成／沒完成＝失敗與取消）與專案；有篩選時對話不顯示（它沒有狀態與專案），篩選圖示亮點。篩選只存在畫面，不存起來。
- **資料夾選擇器**（`packages/server/src/folders.ts`）：`GET /api/fs/folders?path=`（預設家目錄，支援 `~`）回 `{path, parent, home, isGit, crumbs, folders: [{name, path, isGit}], truncated}`；**只列資料夾名稱**，不列檔案、不讀內容、隱藏所有 `.` 開頭的資料夾，最多 500 筆。不能瀏覽（403）：Joy 資料夾（`JOY_HOME`，不管在哪）、家目錄底下 `.` 開頭的資料夾、`~/Library`、`~/AppData`、任何位置的 `.ssh`／`.gnupg`／`.aws`／`Keychains`。路徑先 `resolve`（收掉 `..`）再 `realpath`（跟著連結走），兩者都要過，所以 `x/../.ssh` 和指向 `.ssh` 的連結都擋得住，列表裡指向禁區的連結也不列；比對不分大小寫（macOS／Windows）。相對路徑、含 NUL、超過 4096 字、不是資料夾回 400，不存在 404。需要 api token，與其他 API 一樣。`POST /api/fs/git-init` `{path, confirm: true}`（沒有 `confirm: true` 回 400）：`git init`、分支 `main`、一個空的初始 commit（Joy 的任務要從預設分支的 commit 開始，沒有 commit 就不能用；沒有 git 身分時用 `Joy <joy@localhost>`，關掉簽章與 hook）。拒絕家目錄與磁碟根目錄（400）、已是 git（409）、禁區（403）；失敗時刪掉剛建的 `.git`。選項 `folderBrowserHome` 讓測試改家目錄。
- **加入專案流程**（`AddProjectDialog.tsx`）：標題右側「＋」、命令面板、新任務頁與設定頁的「加入專案」都開同一個對話框：路徑輸入框（可貼上，Enter 或「前往」）、麵包屑、上一層、資料夾列表（git 專案有分支圖示與「選擇」按鈕）、「選擇這個資料夾」。選了 git 專案進到預設分支（預設 main）與容器選項再「加入專案」；不是 git 專案顯示「在這裡 git init」，要再按「確認 git init」才會送出。加入失敗的原因顯示在對話框裡（原本是對話框後面的 toast）。後端 `POST /api/repos` 沒改（仍不檢查是不是 git）。
- **沒做**：`apps/desktop`（Tauri）這個分支上不存在，所以沒有接原生對話框；右鍵選單沒做，只有 ⋯。Windows 的磁碟機清單沒處理（路徑可以貼，但沒有「所有磁碟機」那一層）。
- **測試**：db 6 個（`pins.test.ts`：釘選不動 updated_at、保留第一次時間、封存取消釘選、已封存不能釘、migration 前的舊資料、對話）；server `folders.test.ts` 12 個（排序與只列資料夾、git 標示含 worktree 的 `.git` 檔、`~`、禁區、`..`、連結、400／404、500 筆上限、git init 含沒有身分與強制簽章的環境、拒絕家目錄與根目錄）；`sidebar-api.test.ts` 9 個（token、403／404／400、git-init 要確認、PATCH 釘選與 409）；web `sidebar-groups.test.ts` 14 個；e2e 新增 `sidebar-projects.spec.ts` 8 個（釘選／取消、封存取消釘選、篩選與收合記憶、專案設定、選擇器各步驟、git init 確認、貼上路徑錯誤），並改了 declutter／shell／project-settings／t1.8／container／memory／stats 的相關步驟。
- **驗證**：`pnpm check` 通過（vitest 1307 passed、4 skipped）。e2e 用不提交的暫時 harness（fake runtime 4398＋Vite 4173，proxy 都指向 4398，啟動時檢查不含 4317／5173，跑完已刪除）：全部 115 個（排除會自己開 5173 的 origin-proxy）通過；`sidebar-projects` 重複跑 12 次（96 次）全過。淺色與深色模式的側邊欄、⋯ 選單、選擇器截圖都看過；手機寬度沒看（只有 `@media (hover: none)` 讓 ⋯ 與區塊工具常駐）。
- **沒驗證到**：沒有在真實家目錄上跑選擇器（測試都在暫存目錄），真實的 macOS 權限提示（Documents、Desktop 的隱私權限）沒遇到；Windows 路徑只靠 `node:path` 與不分大小寫比對，沒有在 Windows 跑。
- **決策**：頂端維持「新任務」與「聊聊」兩個鈕（鉛筆圖示換給新任務），最近項目的鉛筆圖示叫「新對話」是為了不和「新任務」重名；釘選用欄位而不是另開表，這樣刪除任務時自然一起消失；選擇器用 server 端點而不是瀏覽器的 File System Access API，因為要拿到絕對路徑。
- **審查後修正**：(1) `git init` 的初始 commit 加 `-c core.hooksPath=<空的暫存目錄>`（跨平台，不用 /dev/null），擁有者的全域 `core.hooksPath`、template 帶來的 hook、新 repo 裡的 `prepare-commit-msg`／`post-commit` 都不會跑，commit 訊息也不會被改；暫存目錄用完刪除。(2) git 子行程的環境移除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_COMMON_DIR`、`GIT_NAMESPACE`、`GIT_PREFIX` 與所有 `GIT_CONFIG*`（GLOBAL／SYSTEM／NOSYSTEM／COUNT／KEY_n／VALUE_n／PARAMETERS，名稱不分大小寫），共用的 `gitEnvironment()` 在 `packages/executor/src/git.ts`（`@joy/executor` 匯出），executor 的 `git()` 與 server 的 `git init` 都用它。(3) `git init` 拒絕家目錄、JOY_HOME，以及它們的任何上層資料夾（400）；Windows 網路路徑（`\\host\share`、`//host/share`、`\\?\…`）在列表與 `git init` 都回 400，列表中指向網路路徑的連結也不列。(4) pins 的 migration 改成 25（#147 的 `task_allows` 是 24）；這個分支已先併入 `origin/task-diff-allow` 讓編號連續，#147 合併後同樣的 commit 不會重複。測試：`folders.test.ts` 16 個（新增：hook 不執行含 mutation 驗證、GIT_* 環境變數、上層資料夾、網路路徑）、`git.test.ts` 新增 `gitEnvironment` 與 `git()` 共 3 個。

### 執行中排隊下一則訊息、回到某一輪重做（2026-11-16，分支 `queue-rewind`，基於 `task-diff-allow`）

- **盤點**：server 原本就有 `queuedMessages`（只在記憶體，重啟後前端標「未送達」）、`steer`／`interrupt`、#145 帶設定的訊息排到這一輪結束、取消時撤回；executor 有檢查點（`checkpoint`／`restoreCheckpoint`，先驗 ref 與 `expectedCommit`、要丟 commit 時先拒絕，之後才動檔案）；#145 的 `handoff.ts` 會把對話組成新 session 的第一個 prompt。補的是：預設排隊、佇列可改、佇列持久化、每輪開始前的檢查點、重做 API 與 UI。沒有新 migration，`packages/core`、`packages/policy` 沒動。
- **排隊（server）**：`POST /api/tasks/:id/messages` 新增 `queue: true`（與 `interrupt` 互斥，400）。任務在跑時一律 `delivery: 'queued'`，不 steer、不打斷；不在跑時照舊直接 follow-up。沒帶 `queue` 的舊行為（可 steer 就 steer）不變，「請 agent 修 CI」、Telegram 等呼叫端不受影響。新路由：`PATCH /api/tasks/:id/queued/:messageId {text}`（事件 `user.message.edited`）、`DELETE /api/tasks/:id/queued/:messageId`（`user.message.discarded {reason:'owner'}`）、`PUT /api/tasks/:id/queued {ids}`（必須剛好是目前佇列的每個 id，否則 409；事件 `user.message.reordered`）。訊息已被 agent 拿走時改／刪回 409。同步的記憶體操作，不經 `exclusive`（不會跟送訊息互相 409）。`GET /api/tasks/:id` 的 `queuedMessages` 多了 `attachments`（數量）與 `settings`（布林）。
- **送出方式：合併成一輪**。這一輪結束後，佇列裡的訊息照順序合併成一個 follow-up（沿用既有 `takeQueuedMessages` → `followUpPrompt`；帶設定的訊息仍在它之前切開）。理由：每輪都是一次完整的 CLI run（時間、額度、檢查點、審查都要再跑一次），逐輪送會讓三則補充變三輪工作；Claude Code 的佇列也是一起送出；擁有者已經能在送出前調整順序與內容。
- **持久化**：佇列不另開資料表，從事件重播（`packages/server/src/turns.ts` 的 `pendingMessages`：`user.message` 的 queued／steer／interrupt，扣掉 delivered／discarded，套用 edited、reordered、steer 失敗的 requeued 排到最後、`task.rewound` 清空）。`user.message` 事件現在帶 `settings`，帶設定的排隊訊息重啟後設定也還在。server 啟動時重建每個任務的佇列並設成「保留」（`heldTasks`，原因 `Joy restarted`），不會自己開跑；對還沒通知過的訊息發 `user.message.held`。擁有者按「繼續」或再送一則訊息時一起送出。啟動時已被擁有者取消撤回的訊息不會回來；被 Joy 關機中止（`close()` 讓任務變 cancelled）的訊息會回來。
- **前端**：任務在跑（queued／running／awaiting_approval）時 Enter 送 `queue: true`；⌘/Ctrl+Enter 或輸入框右下的閃電鈕「立即插話」走原本的即時補充（steer，不行就排隊）。佇列顯示在輸入框上方（`components/QueuedMessages.tsx`）：每列一行文字、往前／往後、修改（行內輸入框，Enter 存、Esc 取消）、刪除。排隊中的訊息不再同時顯示在時間軸，交給 agent 後才以泡泡出現在原位置（標「已交給 agent」）；原本「N 則訊息排隊中…」那行拿掉，保留「已停下，等你繼續」、打斷中、交付中三種說明。時間軸上修改／排序是安靜事件。
- **每輪開始前的檢查點**：每次 run 拿到 worktree、agent 動手前建立檢查點（label `before turn`，事件 `checkpoint.created` 多 `turnStart: true`；single、先規劃、review loop 都有，compete 照舊不建）。和原本「實作者完成一輪」的檢查點共用編號，所以每輪多一個檢查點（選單「檢查點」顯示「這一輪開始前」）；`thread-api.test.ts` 的兩個檢查點測試改了編號。
- **重做（server）**：`POST /api/tasks/:id/rewind {messageId, text, confirm?}`，`messageId` 是某一輪的第一則擁有者訊息，或 `task`（第一輪，也就是任務本身的 prompt）。`GET /api/tasks/:id` 新增 `rewindPoints: [{messageId, ids, checkpoint}]`（`turns.ts` 的 `rewindPoints`：follow-up／plan 回饋或排隊後以 follow-up 送出的那批訊息開始一輪，該輪的 `turnStart` 檢查點就是還原點；中途 steer／interrupt／next_turn 送到的訊息屬於當下那一輪；沒有 `turnStart` 檢查點的舊任務沒有還原點）。流程（在 `exclusive` 裡）：
  1. 先檢查、不動任何東西：compete 409；任務在跑或等核准 409（「stop it」）；找不到該輪 404；檢查點的 worktree 已移除、或和目前 worktree 不同 409；拒絕還原到 repo 主 checkout；目前設定的實作者被 repo 不允許 422；有 `publish.done`（已開 PR）而沒 `confirm` 409。
  2. 目前狀態先存成新檢查點（之後還能還原回來），再 `restoreCheckpoint`（ref 不存在、ref 指到別的 commit、要丟 commit 而沒 `confirm` 都在動檔案前丟錯 → 409，不發 `task.rewound`、不建 attempt）。
  3. 成功後：新 attempt（同一個 worktree／branch／base commit、**沒有 session**，provider／model 用任務目前的實作者設定）；發 `task.rewound {messageId, fromSeq, checkpoint, savedAs, discardedIds, discardedCommits, diff, previousPrompt?}`。`fromSeq` 到這個事件之間的事件、以及 `discardedIds`（該輪與之後的擁有者訊息、佇列裡的訊息）視為捨棄，**不刪資料**。`effectiveEvents()` 濾掉捨棄的部分並套用訊息修改，`ownerMessages`（審查者的任務說明）、`planApproved`、`pendingPlan`、換一家的 handoff 都改讀它。
  4. 重送：第一輪時把任務 prompt 換成新文字（舊的在 `previousPrompt`，`updateTask` 新增 `prompt` 欄位），用新 session 跑原本的第一個 prompt；其他輪發新的 `user.message {delivery: follow_up|replan, rewoundFrom}`，原本那一輪的附件跟著重送，prompt 由 `handoff.ts` 新增的 `rewindHandoffPrompt` 組成（說明擁有者回到較早的點、之後的已丟掉、這是新 session；任務、到那一輪為止的對話、還原後的 diff、再接 follow-up 或改計畫的 prompt）。之後的 follow-up 接新 session。
- **重做（前端）**：時間軸上可重做的擁有者訊息（含最上面的任務 prompt）滑過時出現 undo 鈕「從這裡重做」（觸控裝置一直顯示）；點了變成行內編輯框（預填原文，Enter 送、Esc 取消）。伺服器回「有 PR」或「會丟 commit」的 409 時，在編輯框裡顯示一句說明與「仍要重做」，再送 `confirm: true`（不用瀏覽器 confirm）。任務在跑、等核准、compete 時不顯示按鈕。捨棄的部分在時間軸收合成「▸ 已捨棄（N 則訊息）」，展開後變淡；任務結束收合「過程」時它仍單獨顯示。「重做」本身是一行擁有者決定。變更面板讀 `task.rewound` 的 diff。
- **測試**：server `queue-rewind.test.ts`（8 個，fake provider；重做用暫存 git repo＋真的 `WorktreeExecutor`）：可 steer 的 run 也不 steer 排隊訊息、改／排序／刪除後只開一個 follow-up 且順序與文字正確；已送出的不能改刪、排序不符 409、`queue`+`interrupt` 400、空字串 400；重啟（同一個 DB 開第二個 server）後佇列、修改、順序都在，不自動開跑，再送訊息時照順序送出；重做第二輪：檔案回到第一輪結束、新 session（沒有 `resumeSessionId`）、prompt 有任務與第一輪回答但沒有之後的內容、`discardedIds`、資料沒刪、`savedAs` 可還原回來、之後的 follow-up 接新 session、被捨棄的輪不能再重做；重做第一輪換掉 prompt；執行中 409、compete 409／沒有還原點、未知輪 404；有 PR 要 `confirm`；檢查點 ref 被刪時 409 且 worktree、事件、attempt 都沒變。`turns.test.ts`（6 個純函式）、`handoff.test.ts`（+1）、db `updateTask` prompt（+1）。web：`rewind.test.ts`（6 個：捨棄收合、收合過程時保留、diff、還原點解析、確認文字、修改後的文字、排隊中不出現在時間軸、移動、`queue` 參數）、`ThreadComposer.test.tsx`（+2）、`messages.test.ts`、`checkpoints.test.ts` 更新。e2e `thread-api.spec.ts`：原本兩個改成「⌘/Ctrl+Enter 立即插話」與「Enter 排隊並列在輸入框上方」，新增 3 個（佇列往前／修改／刪除送出的請求；重做：編輯、PR 警告在頁面內確認後帶 `confirm` 重送、重新整理後「已捨棄（1 則訊息）」且只剩第一輪可重做；執行中沒有重做鈕）。
- **驗證**：`pnpm check` 通過（format、lint、typecheck；vitest 1380 passed、4 skipped）。e2e 用不提交的暫時 harness（假 runtime 4399＋Vite 4174，proxy 指向 4399 並把 Origin 改成 server 允許的 5173 字串；沒碰 4317／5173／4173），略過固定連 5173 的 `origin-proxy.spec.ts`，116 個全過；跑完已刪 harness 並關掉 process。
- **審查後修正（同分支第二個 commit，先合併 `task-diff-allow` 的 407448d）**：
  - **升級後不重建舊版遺失的訊息**（必修）：新寫入的等待中訊息（`user.message` 的 queued／steer／interrupt）帶 `persisted: true`，`pendingMessages` 只重播有標記的；舊版的佇列只在記憶體、重啟遺失時沒有寫 discarded，不會被當成還在等。另外，一則訊息在某個 run 開始時還在等、到下一個 run 開始時仍沒有 delivered／discarded，就當作遺失（每個 run 開始後就會拿走佇列；只看「下一個」而不是「第一個」 run，是因為按「繼續」時 `started` 先寫、`next_turn` 才拿訊息，帶設定的訊息也會留到這個 run 結束）。啟動時已完成（`done`／`review_ready`）或已封存的任務不重建。
  - **還原到一半失敗**：executor 新增 `CheckpointRestoreIncompleteError`（`reset --hard` 之後的 `clean`／`read-tree` 失敗時丟）。server 在重做與「還原檢查點」兩條路徑都發 `checkpoint.restore_failed {n, savedAs, message}`（時間軸紅色一行「還原到一半失敗；還原檢查點 N 可以回到之前的狀態」），回 500 並寫明要還原哪個檢查點；前端錯誤訊息也翻成同一句。重做時不發 `task.rewound`、不建 attempt。
  - **複查後的三項小修（第三個 commit）**：(1) `pendingMessages` 遇到 `run.interrupted` 時重設「哪些訊息看過 run 開始」：接續中斷的 run 會拿走等待中的訊息，不算跳過，修正連續兩次中斷後重啟只重建最後一則的問題；(2) 啟動時已完成或封存的任務若還有等待中的 persisted 訊息，寫 `user.message.discarded`（原因「Joy restarted after the task had finished; the message was never sent」），時間軸不再顯示等待中；(3) `reset --hard` 本身失敗也算還原到一半（`CheckpointRestoreIncompleteError`，server 照樣告訴擁有者還原哪個檢查點）。測試：`turns.test.ts` +1（兩次中斷後依序重建 S、I1、I2）、`queue-rewind.test.ts` 重啟測試補 discarded 斷言、executor `worktree.test.ts` +1（用 `index.lock` 讓 reset 失敗）。
  - **重做保留「這個任務內一律允許」**：`task_allows` 是擁有者明確給的精確指紋，與哪一輪無關，重做不清除（只有封存會清）。
  - 測試：server `turns.test.ts` +2（舊版沒標記的不重建、有標記的重建；剛開始的 run 不算遺失、被下一個 run 跳過才算），`queue-rewind.test.ts` +2（重啟時舊版訊息、已完成、已封存的任務都不重建，有標記的會；用 `WorktreeExecutor` 子類別模擬 reset 後失敗：500、錯誤寫出 `savedAs`、有 `checkpoint.restore_failed`、沒有 `task.rewound`、還原 `savedAs` 後檔案回來）；web `rewind.test.ts` +1。
- **沒驗證到**：真實 Claude Code／Codex CLI 沒呼叫（新 session 的 handoff prompt 只驗證到 provider 收到的內容）；畫面只用 e2e 斷言，沒有截圖看深色模式與手機寬度；舊任務（這個分支之前跑的）沒有 `turnStart` 檢查點，無法重做；重做第一輪時舊 prompt 只存在事件裡，畫面頂端顯示新 prompt，舊 prompt 不會出現在「已捨棄」裡；server 啟動時為了重建佇列會讀每個任務的事件，任務很多時啟動會慢一點（未量測）。

## 已確認決策

- 2026-11-19 審查依據實際檢查結果（擁有者要求審查要有真實驗證、審查者不加寫入權限；以下細節為 agent 決定，`packages/core`、`packages/policy` 沒動）：(1) 延伸既有送審前檢查，不讓審查者 CLI 跑 shell；(2) 只跑專案的 `checkCommand`，不從任務文字抽指令；(3) 審查者 prompt 一律說明跑了什麼或沒跑，通過的輸出結尾也給；(4) 略過的檢查不擋核准（沿用既有行為），但審查者會被告知沒驗證。
- 2026-11-18 加入專案對話框的時序（擁有者要求修 `t1.8` 偶爾失敗）：原因是第一次列出家目錄的結果在「全選」與「插入文字」之間抵達，把輸入框換成家目錄，貼上的路徑就接在後面（CI 上變成去 `/home/runner/tmp/...`；本機用暫時測試重現出 `/Users/jimmy/tmp/x`）。真人先 ⌘A 再貼上也會遇到，所以輸入框的 keydown／pointerdown 也算開始編輯，載入結果不再覆蓋。Playwright 的 `fill` 不發這些事件，`t1.8`、`container.spec.ts` 另外改成先等第一次列表再輸入、並檢查輸入值。新增 e2e 先失敗（`/home/me/home/me/code`）後通過；e2e 133 passed，`pnpm check` 1540 passed。
- 2026-11-17 專案 hooks（擁有者要求「偵測專案 hooks」；以下細節為 agent 決定，`packages/policy`、`core`、`secrets` 沒動）：每次 Claude Code run 前（包住 `claude-cli` provider，含注入的）讀 cwd 的 `.claude/settings.json`，取會自己執行的鍵（hooks、statusLine、apiKeyHelper、awsAuthRefresh、awsCredentialExport、otelHeadersHelper、enabledPlugins、extraKnownMarketplaces）算 SHA-256；和 `repos.trusted_claude_settings`（migration 27）不同就用現有核准卡（`run_outside_worktree`、approve）在任務裡問，同意後記在專案上，拒絕或逾時就不啟動、任務失敗；沒有任務可問（例如助理）就拒絕。只改 permissions 等其他鍵不再問；JSON 壞掉也問。另外每個 Claude run 都加 `--strict-mcp-config`（實測沒加時會啟動 repo 的 `.mcp.json` server 與帳號的 claude.ai connectors）；`env` 也算（實測專案 env 在未信任資料夾生效）。Tool Hub 的 peer 用 worktree 找回任務來問；等核准用任務的取消訊號（peer 請求 55 秒就放棄，核准卡照樣等完整時限）；逾時後再按同意只記住信任，不續跑（第一個 run 還沒有 session 可續），要重送任務；Joy 重啟後這種逾時卡會走一般的延遲核准流程（未處理，低）；env 只顯示變數名稱，值只進指紋；compete 兩個 Claude 共用同一張卡；設定路徑不是一般檔案或超過 256 KB 就拒絕。Codex、skill／agent frontmatter 的 hooks 不在範圍；Joy 讀檔到 Claude 讀檔之間仍有短暫空窗（需要 agent 已留下背景程序）。驗證：`pnpm check` 1538 passed；新增單元與整合測試（問、同意後不再問、改了再問、拒絕不啟動、沒指令不問、peer、逾時後同意、FIFO、env、BOM）；reviewer 審過一輪並修正。
- 2026-11-17 e2e 埠（擁有者要求「e2e port 可設定」）：Playwright、fake preview 與 `origin-proxy.spec.ts` 從 `apps/web/e2e/ports.ts` 讀 `JOY_E2E_WEB_PORT`（預設 5173）和 `JOY_E2E_API_PORT`（預設 4317）；server 新增 `playwrightOriginPort`（預設 4173，只在 `allowPlaywrightOrigin` 時生效），fake preview 一律信任自己的 port。`vite.config.ts` 不變（`pnpm web` 仍代理到 4317），埠只在 fake preview 的 inline config 覆寫。驗證：`JOY_E2E_WEB_PORT=4399 JOY_E2E_API_PORT=4398 pnpm test:e2e` 132 個全過（含以前換埠必失敗的 `t1.8`、`origin-proxy`）。
- 2026-11-17 安全缺口（擁有者要求「先補安全缺口」；以下細節為 agent 決定，`packages/policy`、`packages/core`、`packages/secrets` 沒動）：(1) Claude 用 `--setting-sources user,project`：拿掉會繞過 Joy 的 `settings.local.json`，保留專案 skill、指令與 CLAUDE.md；專案 settings.json 的 hooks 仍會執行，視為加入 repo 時的信任。(2) http MCP 設成唯讀前用確認視窗，不另外加說明文字（介面減量）。(3) 單一實例用 SQLite 獨佔鎖檔 `<JOY_HOME>/joy.lock`，不用 pid 檔，避免殘鎖與 pid 重用。
- 2026-11-17 外掛（擁有者要求 `/`、`@` 使用 skill 與 MCP；以下細節為 agent 決定，**policy、core、secrets 待擁有者審**）：(1) MCP server 由 Joy 管理（設定 → 外掛），不改寫使用者的 `~/.claude.json` 或 `~/.codex/config.toml`；(2) 只交給實作者 run，因為只有它有核准管道；(3) 預設每個工具都問，「唯讀」只在 auto 免問，而且只是擁有者的宣告，Joy 不驗證那個 server 真的唯讀；(4) skill 只在擁有者這一輪叫出時免問；(5) `@檔案` 只插入相對路徑文字，不附上檔案內容；(6) run 的 MCP 設定檔放 JOY_HOME 底下，不放系統暫存資料夾。

- 2026-11-16 任務用量與耗時（擁有者要求；以下細節為 agent 決定，**`packages/core` 的 `usage` 事件新增 `costSource` 待擁有者審**）：(1) **不新增資料表**，用量從既有事件算，所以舊任務自然沒有資料就不顯示；(2) 「耗時」＝所有輪的 wall-clock 加總**扣掉等核准**，等核准另外記；每輪的時間算法相同；(3) 「tokens」一律＝輸入＋輸出，輸入含快取（Claude 的 `inputTokens` 由 Joy 加上兩種 cache token，與 Codex／OpenAI 一致），快取另外顯示；(4) cost 只在後端有回報或有價目表時才有，並記來源（`cli`／`price_table`／`mixed`）；Codex 沒有 cost，不推算；Claude 的 cost 是 CLI 依標價換算的數字，面板把它標成「CLI 回報」並在提示說明訂閱不會實際扣；(5) 「每一輪」＝一次 run（`started` 到結束事件），不是 review loop 的審查輪；每輪的行是時間軸的獨立項目，完成後收合過程時保留；(6) 統計頁的任務比較只列期間內最新 50 個任務，沒有分頁。
- 2026-11-16 排隊與重做（擁有者要求執行中 Enter 排隊、另有立即插話；以下細節為 agent 決定，待擁有者確認）：(1) 排隊訊息在這一輪結束後**合併成一個 follow-up** 送出（不逐輪），理由見驗證結果；(2) 立即插話的快捷鍵是 ⌘/Ctrl+Enter，另有閃電鈕；API 沒帶 `queue` 時保持原本的「可 steer 就 steer」，只有網頁的 Enter 帶 `queue: true`；(3) 佇列從事件重播、不加資料表；重啟後佇列保留但不自動開跑，等擁有者繼續或再送訊息；(4) 每次 run 開始前多建一個檢查點作為重做點，和既有檢查點共用編號；(5) 重做以「輪」為單位（開 run 的那批擁有者訊息），中途插話的訊息不能單獨重做；第一輪可重做並換掉任務 prompt；(6) 重做一律新 attempt、新 session，實作者用任務目前的設定；有 PR 或會丟 commit 時要確認，確認在頁面內；(7) 重做會清掉當下佇列裡的訊息（它們是在被捨棄的輪次之後寫的）；(8) 被捨棄的事件不刪，只在 `task.rewound` 記範圍，所有讀「目前對話」的地方改用 `effectiveEvents`；(9) 重做**保留**這個任務的「一律允許」（`task_allows`）：那是擁有者明確給的精確指紋，與哪一輪無關；(10) 重啟後只重建本版本寫入（`persisted: true`）、而且沒被之後的 run 跳過的排隊訊息，已完成或封存的任務不重建；還原到一半失敗時告訴擁有者還原剛存的檢查點。
- 2026-11-16 一律允許的審查後修正（依協調者轉達的審查意見；**policy 變更待擁有者審**）：Grep／Glob／LS 不提供記住；Grep／Glob 在每種模式都檢查 pattern／glob 與起點是否碰到秘密（碰到就是 `forbidden`）；含展開或把文字 pipe 進直譯器的指令不提供記住；WebFetch 的按鈕寫出 host；路徑規則依 `env.platform`（同 #144）。
- 2026-11-15 核准卡「這個任務內一律允許」與任務頁 diff／開 PR（擁有者要求；以下細節為 agent 決定，**`packages/policy` 的新檔 `task-allow.ts` 與 `shell.ts` 的 `analyzeShellConcerns` 待擁有者審**，`packages/core` 沒動）：(1) **指紋**＝種類＋正規化目標：`shell` 是完整指令字串（只 trim、`\r\n`→`\n`，不壓縮內部空白，因為引號內空白有意義；不是程式名，所以允許 `rm -rf build` 不等於允許 `rm -rf ..`）加上相對工作副本的執行目錄（Claude 一律以工作副本根判斷，Codex 用請求的 `cwd`），Claude 與 Codex 的同一指令在根目錄時指紋相同；`file_write`／`file_read` 是解析後的絕對路徑（讀寫分開，Windows 轉小寫）；`network` 是 URL 的 host（只有 Claude 的 WebFetch；WebSearch 沒有 host，不提供）；MCP 工具不提供（`mcp` 種類只留在 DB CHECK 裡，不會產生）。理由：範圍窄到「擁有者看到的那一件事」，參數一變就重問。(2) **不提供**：policy 判為 `forbidden`（密鑰、憑證、Joy 自己的資料、`security`／`gpg` 等，三種模式都問的那些）；指令裡**任何一段**碰到網路程式（`curl`、`ssh`、`gh`…）、git 遠端（push、fetch…）、套件發佈或 lockfile 以外的安裝（為此新增 `analyzeShellConcerns`，列出所有理由，不只回報的第一個，所以 `rm ../x && git push` 也不提供）；指令看不懂（unparseable）；外部內容任務；Codex 寫入沒有 `grantRoot`、`writeStdin`；**所有 MCP 工具**（依協調者 2026-11-15 指示：拿掉依名稱判斷唯讀的放寬，不認得的 MCP 工具維持每種模式都要問）與不認得的工具。(3) 判斷能不能記一律用 `auto` 的分析（最嚴），跟任務目前的模式無關。(4) 失效時機（依協調者 2026-11-15 指示）：只有封存、丟棄工作副本、刪除；`done`／`review_ready` 不失效，完成後的 follow-up 沿用；`failed`／`cancelled` 與重啟也保留（重啟會把執行中任務標成 `failed`，需求要求重啟後仍有效）。(5) 指紋只在 server 端由 policy 計算、存在 broker 記憶體（重啟時待核准的請求本來就全部過期），前端只能送 `scope:'task'`；DB 存 SHA-256，不存原始指令。(6) Telegram 不加這個按鈕。(7) diff 上限：單檔 400 行以上預設收合、一次畫 500 行、預設展開累計 2,000 行、整份 patch 超過 2,000,000 字元只列檔案；「開 PR」移到 diff 面板最上面，沒有 remote 時任務頁底部保留輸入網址的欄位。
- 2026-11-15 專案設定（擁有者要求；以下細節為 agent 決定，`packages/core` 與 `packages/policy` 沒動）：(1) 專案指示只放在「開新 session」的 run 的 prompt 最前面，接續 session 的 run 不重複；改了指示只影響之後新開的 session，已開的 session 維持原樣；(2) 專案指示上限 20,000 字（server、DB CHECK、設定頁 textarea 三處同值）；(3) 安裝指令存 argv、不經 shell，取代 lockfile 判斷（沒有 lockfile 也跑），仍只在 auto／full、非外部內容、非容器專案執行，失敗不擋任務；(4) 專案預設只在首頁輸入框套用，server 建任務（API、助理、排程）不套用；預設不能超過專案允許的服務與最高權限（儲存時回 422，顯示時再 clamp 一次）；(5) 切換專案時預設覆蓋輸入框、沒預設的欄位和沒預設的專案沿用目前輸入框（也就是上次的選擇），套用結果會存回 `joy.composer.v1`；頁面每次打開，第一個專案的預設也套用一次，所以在有預設的專案手動改過的選擇，離開首頁再回來會被預設蓋回去；(6) 側邊欄在 2 個以上專案有未封存任務時才分組，組序＝專案加入順序，收合狀態存 localStorage `joy.sidebar.collapsed.v1`。
- 2026-11-15 任務中切換模型、做法與權限（擁有者要求；以下細節為 agent 決定，待擁有者確認）：(1) 設定跟著下一則訊息送出，只在選單上改不會立即生效；(2) 任務在跑時，帶設定的訊息一律排隊（不 steer、不打斷），它和後面的訊息都等這一輪結束才送；(3) 同一家換模型或 effort：續用同一個 session，更新 `attempt.model`；換一家：同一個工作副本開新 attempt、新 session，第一個 prompt 是從事件紀錄組出來的交接摘要（不呼叫模型），之後接新 provider 自己的 session；(4) 只能在 single 和 review_loop 之間切換，compete 任務與切成 compete 都不開放；權限模式依建立任務的規則（外部內容固定 `ask`、專案上限 clamp）；(5) 值跟目前設定相同就當作沒有設定，不記事件；(6) `task.settings` 在任務完成後收合時仍然顯示；(7) 輸入框高度上限是 12 行或視窗的 40%，助理對話的輸入框也一樣。沒有新的 migration，沒有改 `packages/core` 的介面。
- 2026-11-15 每個任務的權限模式（擁有者核准三種模式與各自的範圍；以下細節為 agent 決定，**core 與 policy 的變更待擁有者審**）：(1) 網頁新任務預設選 `auto`；API 沒給模式、助理 `create_task`、排程任務都是 `ask`；既有任務 `ask`，外部內容一律 `ask`，專案可設最高模式、server 降級；(2) 三種模式的 CLI 旗標相同（Claude `acceptEdits`＋核准工具、Codex `workspace-write`＋`on-request`），`full` 不用 `bypassPermissions`／`danger-full-access`，好讓密鑰與 Joy 設定一定經過 Joy；(3) 分類器是方便用的啟發式，邊界是 CLI 的 sandbox；Claude 的 Bash 沒有 sandbox 是已知缺口；(4) `full` 放行的動作以 `ClassifiedAction.grant` 標記，不新增 `ActionKind`；(5) OS 暫存目錄算工作區；(6) worktree 建好後依 lockfile 安裝相依套件，只限 `auto`／`full` 且非外部內容的任務，失敗不讓任務失敗，容器專案不在本機裝；(8) 非 Joy 的 MCP 工具與未知工具在 `full` 也要問；(7) Codex 檔案寫入沒給 `grantRoot` 時 `full` 也問。
- 2026-11-15 Windows CI 偶發逾時（agent 決定）：`db`、`executor`、`server` 會跑真實 git／SQLite 的測試，`testTimeout` 拉到 30 s、`hookTimeout` 60 s；測試暫存目錄用 `rmSync(..., { maxRetries: 5, retryDelay: 100 })` 清理，避開 Windows `EBUSY`。不跳過、不弱化測試。
- 2026-11-15 實作者的核准管道（agent 決定）：所有會寫程式的實作者 run（single、review loop、compete、合併版）都接 Tool Hub 與 approval tool；計畫與審查（唯讀）不接。Codex app-server 的核准處理器只在實作者回合掛上。orchestrator 的 `ReviewLoopInput.mcpServers／approvalTool`（未使用、且會連審查者一起給）改為 `implementerTools(ws)`。
- 2026-11-15 任務頁整理（擁有者原則，實作細節為 agent 決定）：任務完成（`done`／`review_ready`）或失敗／取消後，時間軸預設只留使用者訊息、agent 最後一則訊息、最後一個審查卡與錯誤，其餘收進「過程」；執行中、等核准計畫與比賽任務維持展開。標題列只有狀態點、單行標題、「變更」與「⋯」；任務標題顯示一律用 `shortTitle()`（約 24 全形或 48 半形字元）。選中、聚焦、卡片一律中性（不用 accent 色塊、外框或光暈）。
- 2026-11-14 擁有者決定：通過本機 listener 接受自身 Origin（#134）、附件的 core 介面 `RunOptions.images`／`ImageInput`／`Steer` 第二參數（#138）、文字附件定位為參考資料而非擁有者指示，以及附件上限（圖片 3.75 MiB、文字 256 KB、每則 10 個、每任務 40 個／100 MB、每次 run 最多 8 張圖與 256 KB 文字）。

- 2026-11-14 附件（agent 決定，待擁有者確認；第二輪依審查修正）：(1) 只收圖片（PNG／JPEG／GIF／WebP，原始 ≤ 3.75 MiB＝base64 後 ≤ 5 MiB）與文字／程式碼檔（UTF-8，≤ 256 KB，內容放進 prompt），PDF 與其他二進位不收；每則 ≤ 10 個、≤ 20 MB；每任務 ≤ 40 個、≤ 100 MB；(2) 檔案存 `<JOY_HOME>/attachments/<uuid>.<ext>`，從不進 worktree，所以不會被 commit 或進 PR；(3) 只有 server 組的擁有者段落放帶行程 nonce 的標記，provider 外層 `withAttachments` 只展開這種標記、只展開同任務的附件、每個檔案引用一次；(4) 審查者也看得到附件，每次 run 最多最新 8 張圖、256 KB 文字，較舊的只給名稱；(5) 文字附件是 reference data，不放進指令清單（擁有者待審）；(6) 容器模式加 Claude 角色時送圖、容器模式文字累計超過 64 KB 時，送出時就回 422；(7) 缺檔改成「[attachment missing]」並發警示事件、run 照常；擁有者可移除已送出的附件，之後只給名稱；(8) prompt 超過 16 KB 時，Claude 與 `codex exec` 改走 stdin；(9) 草稿只保存已上傳附件的 id；未送出的上傳 7 天後刪；備份與匯出不含附件檔案；(10) 助理對話暫不支援附件（2026-11-19 已支援，見「助理對話附件」）；(11) 改 `packages/core` 的 `RunOptions`（可選 `images`）與 `Steer`（可選第二個參數 `images`），列入擁有者待審。
- 2026-11-14 介面不放說明文字，讓介面自己說明（擁有者原則）：新增或修改介面時，不加只是在解釋 UI 的段落、副標題、說明性 placeholder；需要時用 `title` tooltip 或選單第二行小字。保留真正必要的錯誤訊息、確認對話與不可逆動作的提醒。側邊欄只有一個「最近」清單，已封存、統計放在設定。
- 2026-11-14 品牌與專案色（擁有者核准設計；實作細節為 agent 決定）：(1) 品牌色只用在角色與需要注意處（等你、進行中），其餘介面維持黑白，送出鍵維持黑白；(2) 文字用的青色是 `--accent-text`（淺色 `#07726A`），`--accent`（`#0E9C91`）只做線條、圓點、焦點，因為前者在白底不到 4.5:1；(3) 專案色是 6 個固定灰階色，預設依專案順序自動輪流，可在設定改，只當小圓點、不當文字色，儲存 id（`blue green purple orange pink teal`）不是色碼，沒選就是 NULL；(4) 角色與圖示是 agent 依擁有者提供的參考圖用 SVG 重繪，日後可整組替換（見上方「品牌」一節）；(5) 角色轉圈用 CSS 動畫，`prefers-reduced-motion` 時不轉。
- 2026-11-13 擁有者決定：(1) 審過並確認 `packages/core` 的 `RunOptions.onSteer`／`Steer`（#133）；(2) 確認即時補充的細節（下一條 2026-11-09）：只 steer 實作者、容器模式不 steer、10 秒逾時退回排隊、每次審查前重讀任務說明；(3) 因時間上限、花費上限或月預算停下後，排隊訊息**不自動接續**，保持排隊並提示，按「繼續」或再送訊息才一併送出；(4) T4.3 Tauri 繼續延後、P5 其餘繼續暫緩、Telegram 真實 bot 測試維持暫緩；(5) 優先順序：不用終端機（單一程式＋背景服務）→ 輸入框附檔與貼圖 → 新任務選起始分支 → 變更檢視行內留言；(6) 擁有者會先錄 Claude 真實 fixture，並先做 T1.13 與 T1.9 驗收。
- 2026-11-09 執行中插話改為即時補充（擁有者要求不打斷；細節為 agent 決定，**擁有者 2026-11-13 已確認**）：(1) `POST /messages` 預設 `interrupt: false`，可即時補充就 steer，不行就排隊，#132 打斷只在 `interrupt: true`；(2) 只 steer 實作者，審查／檢查／核准／額度排隊時照舊排隊；(3) Claude 只有實作者的 run 用 `--input-format stream-json`，第一個 `result` 就關 stdin，之後的訊息退回排隊；容器 repo 不用（依 `forwardsStdin`）；第一個 `result` 決定成敗，之後輪次失敗只是 recoverable；(4) steer 在 `exclusive` 外依序送，失敗或 10 秒逾時就退回排隊，逾時後晚到的成功會從排隊移除（已被下一輪拿走時仍可能送達兩次）；有排隊中的訊息時新訊息也排隊，維持順序；(7) 審查者只看已交給實作者的訊息；(8) 介面用「已交給 agent」；(5) 改 `packages/core` 的 `RunOptions`（可選 `onSteer`、新型別 `Steer`），列入擁有者待審；(6) 每次審查重讀任務說明，讓審查者看到同一 run 中補充的指示。
- 2026-11-08 執行中插話（agent 決定，待擁有者確認）：(1) 預設打斷實作者目前這一輪、同一 session 帶著訊息接續，`interrupt: false` 保留排隊；(2) 審查、送審前檢查、等待核准、額度排隊、建立 worktree 時不打斷，照舊排隊；(3) 取消優先於打斷，訊息撤回；(4) 打斷後接續沿用原本的截止時間與剩下的審查輪數（reviewer 審查後改定，取代「從頭算」）；(5) 不改 `packages/core`：新事件 `run.interrupted` 與 `delivery: 'interrupt'`／`via: 'interrupt'` 只是事件 payload。
- 2026-11-08 新任務頁模型選單（agent 決定）：(1) 沒選模型就不送 `roleOverrides`，照設定由伺服器解析；(2) 只送被選的角色，不送 `orchestrator`；(3) 投入程度五檔沿用 `EFFORT_LABELS`（低／中／高／很高／最高），不另外叫「極高」；(4) web 複製 `@joy/model-effort` 的 effort 表並以測試比對，不新增 workspace 依賴；(5) 「照設定」「平衡」「省額度」「最強」放在選單的快速套用，其中「照設定」是回到不覆寫的方式。
- 2026-11-08 任務頁：串流回覆（Codex、OpenAI API 逐段送的 `message`／`thinking`）在時間軸合併成一則；輸入框右下顯示實作與審查模型；停止鍵移到輸入框（執行中、輸入框空白時送出鍵變停止），標頭不再有停止鈕。
- 2026-11-08 擁有者決定：(1) 開 PR 後**保留工作副本**，直到 PR 合併或關閉才移除（取代 T2.8「開 PR 後立刻移除」）；有未推送的 commit 時不會移除；(2) `planFirst`／`plan_first` 的任務**一律停下來等擁有者核准計畫**（確認下一條的第 1 點）。
- 2026-11-08 任務對話式 API（agent 決定；第 1 點已由擁有者確認）：(1) `planFirst`／`plan_first` 一律表示「計畫要擁有者核准才實作」，設定檔工作流程的行為因此改變；(2) 執行中插話在下一次 agent 輪送達，沒有下一輪就在結束後自動 follow-up；(3) 送審前檢查失敗時，審查通過也不算完成；外部內容任務的檢查要核准、未核准就略過；(4) 檢查點用 `refs/joy/checkpoints/<task>/<n>`，還原前一定先另存目前狀態；(5) 不改 `packages/core`：executor 的 `run`／`checkpoint`／`restoreCheckpoint` 以 duck typing 偵測（同 `listWorktrees`）。
- 2026-11-07 T3.8 選型：Google 使用 [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)（`uvx workspace-mcp --tools gmail calendar`）。理由：一個 server 涵蓋 Gmail 與行事曆、可限制只開這兩項；用擁有者自己的 Google Cloud OAuth 用戶端在本機登入，資料只在本機與 Google 之間，不經第三方；MIT 授權、使用者多。登入資料由該 server 自己存放，Joy 不經手。備案：只做行事曆的 nspady/google-calendar-mcp（沒有 Gmail）。
- 2026-11-07 擁有者逐項確認：T5.1、T5.2、T5.3、T5.4、T5.5、T5.7 **全部暫不開始**（T5.6 已依擁有者指示完成）。不要再詢問，等擁有者主動提出。
- 2026-11-07 擁有者審過 T4.1 並合併 PR #110（含審查修正：拒絕 0.0.0.0、`remote.https_hosts`、bridge 檢查 loopback Host）。
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

### T3.8 Google 行事曆與 Gmail（程式完成；真實登入與驗收待擁有者）

- `config.yaml` 的 `mcp_servers:` 設定外部 MCP server（command、args，可選的 `tools` 覆寫分類）；Joy 用 stdio 啟動、列出工具，交給助理（OpenAI 大腦是 function call，CLI 大腦走同一個橋接）。SDK 只傳最小環境變數（HOME、PATH…），server 自己找登入檔。
- **每次呼叫都走 `packages/policy` 的 `evaluateAction`**（沒有改規則）：工具名稱對應到既有的動作種類——讀信 `read_mail`、讀行事曆 `read_calendar`、自己的行程 `create_own_event`、寄信／回信／草稿／改標籤 `send_mail`、有其他參加者或會寄通知的行程 `invite_others`；**不認得的寫入一律當成 `invite_others`（要核准）**。
- 讀取直接執行，結果包成 `external_content` 並註明不得照內容指示行事；新增自己的行程執行後在對話裡留「🔔 Done」；寄信、邀請他人建立待核准項目，對話留「🔴」、送 Telegram 與推播，擁有者在助理頁「Waiting for your approval」核准才執行（`POST /api/assistant/actions/:id/approve|deny`）。
- **同一輪讀過信或行事曆後，之後的寫入視為來自外部內容，一律要核准**（policy：external_content 一律 🔴）。
- 待核准項目存在記憶體，Joy 重啟後會消失（需要時請助理重新提出）。
- 驗收：分類測試、真的用 stdio 連一個假 Google MCP server（列出、呼叫、啟動失敗只警告）、server 測試（自己的行程執行並通知；寄信未核准不執行、核准後才執行、重複核准 404；讀信後的寫入要核准且標示來源、拒絕不執行）、Playwright `assistant-actions.spec.ts`。「明天下午有空嗎」答對需要擁有者登入後實測，**PLAN 未打勾**。

### T5.6 自訂工作流程（擁有者 2026-11-07 指定先做）

- 工作流程格式（`packages/orchestrator/src/workflow.ts`）：名稱、模式（`single`／`review_loop`／`compete`）、各角色用的模型、模式的選項（`max_rounds`、`plan_first`，只適用 review_loop）。
- **原本三種任務模式就是三個內建工作流程**，測試逐一確認用新格式產生的任務與原本的模式完全相同（同模式、不改角色、不改選項）。
- 自訂工作流程寫在 `config.yaml` 的 `workflows:`（不能用內建名稱）；設定錯誤會說明原因（模式用不到的角色、非 review_loop 設了回合數、compete 兩個實作者是同一個模型），這種工作流程不能用來建任務。
- 任務可以用 `workflow` 建立（API、建立任務表單、助理 `create_task`）；工作流程給預設值，請求裡明寫的角色與選項優先。用了哪個自訂工作流程記在任務上（migration 17）。`GET /api/workflows` 列出全部與其問題。
- 驗收：orchestrator 測試（三種模式各自等於內建工作流程、選項帶入、錯誤說明）、server 測試（自訂工作流程的模型、回合數、先規劃都生效並跑完；內建 `single` 與舊模式相同；不存在／有問題／模式衝突回 422）、Playwright `workflows.spec.ts`。

### T4.1 遠端存取（預設關閉；擁有者 2026-11-07 審過並合併 PR #110）

- 沒帶 token 或 token 錯誤一律 **401**（之前是 403；403 保留給不允許的 Host／Origin）。WebSocket 同樣 401。
- **Settings → Access token → Regenerate**（`POST /api/token/rotate`）：新 token 寫入 `~/.joy/api-token`（0600，原子替換），舊 token 立刻失效，所有 WebSocket 斷開；新 token 只回傳一次，這個裝置會記住。
- 遠端：`remote: { enabled, address, port }`（預設關），開啟時**另外**在該 IP 上聽（主 listener 仍只聽 127.0.0.1）；只多允許 `http://address:port` 這一個 Host 與 Origin，其他 Host 仍 403（防 DNS rebinding）；Tool Hub 與助理橋接仍只接受 loopback 來源。改設定要重啟。
- server 會提供 `apps/web/dist`（需先 `pnpm --filter @joy/web build`）給遠端瀏覽器；路徑只能在該資料夾內。正式版網頁沒有內嵌 token，會先要求貼上 token（存在該裝置）。
- Tailscale 教學在 README。
- 驗收：server 測試（沒 token／錯 token 401；重新產生後舊 token 401、新 token 可用、檔案權限；遠端 listener 需要 token、未設定的 Host 403、未開啟時沒有遠端 listener；UI 檔案不能跳出資料夾）、Playwright `access-token.spec.ts`（token 被拒時要求輸入、重新產生後改用新 token）、`origin-proxy.spec.ts` 改為 401。
- 審查後修正（2026-11-07）：`remote.address` 拒絕 `0.0.0.0`、`::` 等「聽所有網路」的位址；新增 `remote.https_hosts`（`tailscale serve` 這類本機 HTTPS proxy 的主機名，允許該 Host 與 `https://` Origin，手機 PWA／推播要用）；proxy 也從 loopback 連進來，所以 Tool Hub 與助理橋接**另外檢查 Host 必須是 loopback**；遠端 listener 啟動後的錯誤只記 log，不再讓 Joy 當掉。`tailscale serve` 實際送的 Host 仍待擁有者實測。
- **依 AGENTS.md，擴大到 127.0.0.1 以外需經擁有者審查**：功能預設關閉，列入待審表，擁有者審過再開。

### T4.2 PWA 與 Web Push（程式部分；手機驗收待擁有者）

- 網頁可安裝（`manifest.webmanifest`、圖示），service worker 只負責顯示通知與點通知開到該任務（`/?task=…`），**不做離線快取**（舊 UI 接新 server 比沒有 UI 更糟）。
- 任務結束（✅／🟡／❌）與需要核准（🔴）時，Joy 用自己的 VAPID 金鑰直接送到各瀏覽器的推播服務；內容先經 Redactor 再加密。金鑰第一次使用時產生，存在**鑰匙圈**（新 secret 名稱 `web_push_vapid_keys`，列入待審）。推播服務回 404／410 的訂閱自動刪除。沒有任何訂閱時完全不碰鑰匙圈。
- 設定頁「Notifications」：開啟（要求權限、訂閱、送到 `POST /api/push/subscriptions`）、送測試、關閉。不支援時說明原因（需要 HTTPS 或 localhost；iPhone 要先加到主畫面）。
- 驗收：push 測試（金鑰只產生一次；**用瀏覽器的方式解密**確認內容正確且已遮罩；410 時刪除訂閱）、server 測試（任務完成時對訂閱裝置送出帶 VAPID 的請求；拒絕非 https 端點）、Playwright：manifest、service worker 註冊、**透過 Chromium DevTools 真的推一則訊息，service worker 顯示通知**、開啟流程送出訂閱。
- 手機上要能用：Joy 要能從手機以 HTTPS 開啟（依賴 T4.1 #110：`tailscale serve` 加上 `remote.https_hosts`；`tailscale serve` 實際送的 Host 還沒實測）。「手機加到主畫面後收得到通知」**需擁有者實測，PLAN 未打勾**。

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

- ~~開 PR 成功後立即刪除~~（2026-11-08 擁有者改為）：開 PR 後保留 worktree，`GET /api/tasks/:id/pr` 讀到 PR 已合併或關閉時才刪除並記為 `worktree.removed`；只在有人看這個任務（UI 輪詢 PR 狀態）時觸發，沒人看的已合併任務留到設定頁手動清。PR 開著時可再按「推送更新到 PR」。compete 選定後其他嘗試照舊立即清除。
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
