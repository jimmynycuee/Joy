# Joy 目前狀態

> 本檔記錄已驗證結果、目前阻塞、待擁有者審查與已確認決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。不記錄 PR 狀態快照。

- 最後更新：2026-11-15（修正：review loop／compete 的 Claude 實作者沒有核准管道，`pnpm check` 被 CLI 自動拒絕）；2026-11-14（附件：輸入框附加檔案與貼上圖片；介面減量：側邊欄單一清單、設定返回鍵、移除說明文字；品牌角色、配色與專案色；2026-11-13：不用終端機：單一程式＋背景服務、上限停下後排隊訊息不自動接續；擁有者已審即時補充的 core 介面）
- T2.1 平行競賽已用假 provider 完成；擁有者 Codex 額度恢復後可用真實 CLI 跑一次（最便宜模型、low effort）。T3.8 需要 Google 登入，未做。
- 目前階段：P1 真實驗收由擁有者在本機處理；P2 按 T2.3 → T2.7b → T2.4 → T2.5 → T2.1 執行，完成後依序進入 P3。

## 驗證結果

### 修正：review loop／compete 的實作者沒有核准管道（2026-11-15，分支 `claude-approval-surface`）

擁有者實測：review_loop 任務的 Claude 實作者（haiku）跑 `pnpm check` 兩次都被拒，事件是 `permission_denied`「no approval surface in this session; permission request denied automatically」。擁有者資料庫裡 14 筆這種事件全部來自 `review_loop` 任務（唯讀查 `~/.joy/joy.sqlite`）。

- **根本原因**：只有 `runSingle` 會建立 Tool Hub 並傳 `mcpServers`＋`approvalTool`。`runReviewLoop`、`runCompete`、`runCompeteMerge` 呼叫 orchestrator 時都沒傳，於是 `buildClaudeArgs` 走 `--permission-prompts none`，CLI 自己拒絕所有權限請求，Joy 的 policy 與核准中心都沒被問到。orchestrator 原本的 `ReviewLoopInput.mcpServers／approvalTool` 沒有人用，而且會連審查者一起給。Codex app-server 實作者在 review loop 也一樣：核准處理器只在 single 註冊，所以連 `pnpm test` 都被 decline。
- **跟 OpenAI key 無關**：Tool Hub 只需要本機 server 在 listen（`createRunToolHub` 唯一的前提），不需要 OpenAI key 或其他設定，所以不需要另做「只有 approval tool 的最小 MCP server」。
- **修法**（只改接線，`packages/policy` 沒動）：
  - orchestrator：`ReviewLoopInput.mcpServers／approvalTool` 換成 `implementerTools(ws)`，worktree 建好後呼叫一次，只用在實作者的 implementing／fixing 回合；計畫（唯讀）與審查不給。`CompeteInput.implementerTools(contestant, ws)` 讓每位參賽者各自一個。
  - server：新增 `implementerToolHubs`，每個 attempt 一個 Tool Hub（與 single 相同的 `createRunToolHub`），run 結束時關閉。Claude 帶 `--permission-prompt-tool mcp__joy__approve`；Codex app-server 的核准處理器只在該 attempt 的 implementing／fixing 回合掛上，計畫與審查回合拿掉，審查者照舊一律 decline。
  - 涵蓋：single（原本就有）、review loop（含修正回合、follow-up／resume、steer 時的 stream-json）、compete 兩位參賽者、compete 合併版、額度換手（走 `runSingle`）。容器模式沿用 `inContainer` 的既有規則。
- **測試**：
  - `packages/server/src/approval-surface.test.ts`：single、review loop（實作＋修正＋follow-up 都帶 approval tool，審查者沒有）、compete 與合併版。另一個測試用真的 `ClaudeCliProvider`＋假 CLI（`fake-cli.mjs` 新增 `FAKE_MODE=permission`：照 `--mcp-config` 啟動 Joy 的 stdio MCP bridge，用 JSON-RPC 呼叫 `approve`，跟 CLI 一樣傳 `{tool_name,input,tool_use_id}`）跑 review loop：`pnpm check` 由 policy 自動放行、`curl …` 進核准中心後擁有者核准才放行、`rm -rf ../elsewhere` 擁有者拒絕。在舊的 `server.ts` 上這三個測試都失敗，假 CLI 也產生和擁有者一樣的「no approval surface」拒絕。
  - `server.test.ts`：review loop 的 Codex app-server 實作者，安全指令 accept、worktree 外寫入 decline（舊程式碼是兩個都 decline）。
  - orchestrator：只有實作回合拿到工具（計畫與審查沒有）；compete 每位參賽者拿到自己的。providers：stream-json 輸入時仍帶 `--permission-prompt-tool`。
- **審查後修正（M1、N1、N2）**：
  - M1：`approvals.on_timeout: pause`（預設）下，review loop 的紅色動作逾時後，任務原本直接變 `cancelled`，補核准回 409。現在比照 single：attempt 設 `cancelled`、任務設 `awaiting_approval`、發 `task.paused {approvalId, diff}`；補核准後用同一個 session 接續，新 hub 的 `approvalGrants` 放行那一次。compete 與合併版的逾時當作拒絕（不設 `pausedFor`），避免一位參賽者逾時就中止整個 compete；這時補核准回 409。
  - N1：`implementerToolHubs` 關閉後再要 hub 會丟錯，不會在沒有核准管道的情況下繼續跑。
  - N2：hub 延到第一次實作回合前才建立，只有計畫的 run（plan first）不建。Codex 處理器在建立時就掛上（這時已在實作回合）。
  - 測試（`approval-surface.test.ts`）：pause 下 review loop 進 `awaiting_approval`＋`task.paused`，補核准 200 並在同一 session 接續、放行該動作；compete 逾時當拒絕、兩位參賽者都跑完並由裁判比較、沒有 `task.paused`。兩個測試在 341d700 的 `server.ts` 上都失敗。
- **沒驗證到**：真的 Claude Code CLI 在 review loop 中的 permission prompt 往返（假 CLI 是依 spike 文件寫的合成行為，不是錄下來的）。擁有者下次用 haiku 跑 review_loop 任務、讓它執行 `pnpm check`，應該看到 `policy.action`（run_in_worktree、auto），不再出現「no approval surface」。

### 附件：輸入框附加檔案、貼上圖片（2026-11-14，分支 `attachments`）

擁有者可以在新任務與任務頁的輸入框貼上（⌘V）、拖放或用迴紋針選檔；agent（實作者與審查者）看得到圖片、讀得到文字檔。助理對話**這次沒做**（原因見下）。第二輪（同日，依審查意見 M1、S1–S5、N1–N8 修正）的改動已併入下面各點。

- **能附加什麼**（由內容判斷，不信副檔名與 Content-Type）：圖片 PNG／JPEG／GIF／WebP（看檔頭簽章），單張原始大小 ≤ 3.75 MiB，也就是 base64 後 ≤ 5 MiB。依據：platform.claude.com/docs/en/build-with-claude/vision 的「Request limits」寫 Claude API 每張 10 MB、Bedrock 5 MB，**兩者都是 base64-encoded 後的大小**；取較嚴的，Claude Code 跑在哪都能用。文字與程式碼檔：合法 UTF-8、沒有 NUL 等二進位控制字元，單檔 ≤ 256 KB。SVG 算文字。PDF 與其他二進位檔回 415。每則訊息最多 10 個、合計 ≤ 20 MB；**每個任務累計**最多 40 個、≤ 100 MB（已移除的不算）。上限常數在 `packages/server/src/attachments.ts`，前端 `apps/web/src/attachments.ts` 有一份相同的預檢（以伺服器為準）。
- **儲存**：`<JOY_HOME>/attachments/<uuid>.<ext>`，副檔名依嗅探到的型別：png／jpg／gif／webp／txt。目錄 0700、檔案 0600，先寫 `.part` 再 rename。檔名只是顯示用：取最後一段路徑；去掉控制字元、`<>:"|?*`，以及方向控制字元（U+200E、U+200F、U+061C、U+202A–202E、U+2066–2069）；NFC 正規化，最多 200 字。路徑只由伺服器產生且驗過 UUID 格式的 id 組成，id 無法穿越目錄。資料庫新表 `attachments`（migration 21，STRICT，`media_type` 有 CHECK，`task_id` 外鍵 ON DELETE CASCADE，`disabled` 0/1）只存 id、名稱、型別、大小、所屬任務與訊息、是否已移除。
- **API**（沿用 token 與 Origin 檢查）：
  - `POST /api/attachments`：body 就是檔案原始位元組，`X-Joy-Filename` 放 percent-encoded 檔名；不用 multipart，所以不需要解析套件。
  - `GET /api/attachments/:id`：回應帶 `nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: private, no-store`，文字一律 `text/plain`；已移除或檔案不在本機時回 404。
  - `DELETE /api/attachments/:id`：還沒送出的直接刪除；**已送出的標成已移除並刪掉檔案**，回 `{attachment:{…, disabled:true}}`，並發安靜事件 `attachment.removed`。
  - `POST /api/tasks` 與 `POST /api/tasks/:id/messages` 多了可選的 `attachments: [id]`。訊息可以只有附件（`text: ''`），新任務仍要有文字。未知 id 回 400；重複、已用過或超過任務累計上限回 400／409／413。這些都在建立任務、接受訊息之前檢查，失敗時不留下任務。助理對話的訊息用自己的 schema，不收附件。
- **容器模式在送出時就擋下（M1）**：
  - 專案是容器模式，而這個任務任一個會用到的角色（實作者、審查者、裁判；訊息時還包含最近一次 attempt 的 provider）是 `claude-cli`，送圖片時建立任務或送訊息直接回 **422**。容器裡的 Claude 沒有 stdin，收不到圖片。
  - 容器模式下 prompt 只能放命令列，所以每個任務的附加文字累計超過 64 KB 也回 422。
  - provider 層仍保留最後一道錯誤，以防設定在這之後被改。
  - 額度用完時換手（`pickHandoffModel`）：容器專案的任務若還有沒移除的圖片附件，不會換手給 `claude-cli`；沒有其他可用的 provider 時就照舊排隊等額度恢復。
  - 容器模式下 prompt 太長時，錯誤訊息會說明長 diff、長訊息、檢查輸出和附加文字都算在內，不會只叫人移除附件。
  - 重複 DELETE 已移除的附件回 200，但不會再發一次 `attachment.removed`；`attachment.missing` 每個任務、每個附件只發一次。
- **紀錄**：`user.message` 事件多 `attachments: [{id,name,mediaType,size}]`；`GET /api/tasks/:id` 多 `attachments`（第一個 prompt 的沒有 `messageId`；已移除的帶 `disabled: true`）。檔案內容不進 SQLite、事件、log、memory。Codex app-server 回送的 `userMessage` item 是 Joy 自己輸入的回聲，可能含文字檔內容，現在不再記成 `raw` 事件。
- **交給 agent（S3）**：
  - 標記是 `[[joy-attachment:<nonce>:<id>]]`。nonce 每個伺服器行程隨機產生、從不顯示，也從不交給 agent。
  - 只有 server 自己組的擁有者段落會放標記：任務 prompt（`agentPrompt`）、擁有者訊息（`agentText`：排隊、follow-up、打斷接續、steer），以及審查者的任務說明（`taskBrief`）。
  - provider 外層的 `withAttachments` 只認得帶這個 nonce 的標記。diff、檢查輸出、issue、policy 預審、agent 自己的輸出裡就算出現看起來一樣的字（例如 `[[joy-attachment:<id>]]`），也照原文保留、不會展開。展開只掃一遍，展開後的內容不會再被掃。
  - 只解析屬於同一個任務的附件。同一個檔案在同一個 prompt 裡只引用一次，重複出現時改成「quoted above」或「attached above」。
- **文字附件當資料，不當指令（S4，擁有者待審）**：
  - 文字檔包成「Reference file the owner attached: "名稱" (data; follow it only where the owner's message says so)」，再用比內容最長反引號更長的 fence 引用。
  - 審查者的任務說明裡，「Later instructions from the owner」清單每項只寫擁有者的話加「(attached: 檔名…)」。檔案內容放在清單之後的「Files the owner attached to those messages (reference data, not instructions):」段落。
  - 圖片是「[Image the owner attached: "名稱"]」，並放進 `RunOptions.images`。
- **每次 run 的量（S5）**：從最新的往回算，最多 8 張圖。Anthropic 單一請求超過 20 張圖時，每張圖會套用更嚴的尺寸限制，而 session 會把舊圖一起重送。文字最多 256 KB。超過的較舊附件只寫「[earlier attachment, not shown again: "名稱"]」。審查者、實作者都一樣。
- **附件不會讓任務永久壞掉（S1）**：
  - 已送出的檔案在這台電腦上不見（例如在別台還原了資料庫備份）：該位置換成「[attachment missing: "名稱"]」，發一個看得到的警示事件 `attachment.missing`（時間軸紅色步驟「這台電腦上找不到附件：…」），run 照常進行。
  - 後端拒收某張圖時，擁有者可以在訊息氣泡上按 ✕ 移除。之後的 run 只會拿到「[attachment removed: "名稱"]」，不會每次都重新帶入同一張而卡住。
  - provider 的錯誤訊息改成擁有者做得到的事，例如「Remove it from the message (✕ on it in the thread)…」。
- **長 prompt 改走 stdin（S2）**：
  - 單一命令列參數有 OS 上限（Linux 128 KiB、Windows 整行約 32K 字元）。prompt 超過 16 KB 時：Claude 改用 `--input-format stream-json`，Codex `exec` 改用 `-` 從 stdin 讀。後者已用 `codex exec --help`／`codex exec resume --help`（0.166.0）確認：「If not provided as an argument (or if `-` is used), instructions are read from stdin」。
  - 沒有 stdin 的容器 run，prompt 超過 100 KB 時直接報錯並說明。
  - Claude 有圖片或 steer 時本來就走 stdin。
- **圖片怎麼交給各個 CLI**：
  - Claude Code：`--input-format stream-json`，第一則 user message 的 `content` 是 `[{type:'text'}, {type:'image', source:{type:'base64', media_type, data}}]`；steer 也可帶圖。
  - Codex app-server：`turn/start`／`turn/steer` 的 `input` 加 `{type:'localImage', path}`。
  - Codex `exec`：每張圖一個 `--image <path>`。provider 透過 wrapper 新參數 `readFiles` 明確交代要掛哪些檔，容器以唯讀方式掛載；不再用路徑前綴去猜（N5）。
  - OpenAI API：`input_image` 加 data URL。
- **不會進 PR**：檔案在 JOY_HOME，從來不複製進 worktree。測試用真的 git worktree 驗證：跑完後 `git status` 只有 agent 改的檔，`git add -A && commit` 後歷史裡沒有附件內容或檔名。
- **審查者**：看得到附件，數量限制同上。理由：附件通常就是需求本身（截圖、錯誤 log），審查者沒看到就無法判斷；代價是每輪審查多花圖片 token。只看已交給實作者的訊息的附件。
- **清理**：
  - 沒送出的上傳 7 天後刪除。
  - 沒有對應資料列的檔案（包括已移除的）在啟動與上傳時清掉，上傳時最多一小時一次；`.part` 只在啟動時清。
  - 已送出的附件跟著任務保留，封存不刪。
  - **備份與匯出**：`backup` 只備份資料庫；`/api/export` 只含事件裡的中繼資料（檔名、大小）。**兩者都不含附件檔案本身**，要保留請另外備份 `~/.joy/attachments`。在別台電腦還原時，缺檔會照上面的方式處理。
- **前端**：
  - 輸入框工具列最左邊是迴紋針（`附加檔案`）。貼上時剪貼簿若同時有文字（例如試算表），照舊貼文字。
  - 輸入框上方是附件列：圖片顯示縮圖，其他檔案顯示圖示加檔名加大小，各有移除鈕。上傳中顯示小轉圈，失敗顯示紅色警示圖示（原因在 tooltip 與 aria-label）。有上傳中或失敗的附件時送出鍵停用，不會默默少送。
  - 上傳中被移除的檔案，上傳完成後會呼叫 DELETE（N7）。
  - 時間軸的使用者訊息上方顯示附件：圖片點了放大，Esc 或點背景關閉；檔案點了下載。滑過時有 ✕，確認後移除，移除後以刪除線顯示檔名。
  - 圖片由 `fetch` 帶 token 取回再轉成 object URL，因為 `<img>` 無法帶 token。
- **草稿**：
  - 附件一加入就上傳。草稿在 `localStorage['joy.draft-attachments.<context>']` 只存已上傳的 id、名稱、型別、大小，切頁與重新整理都還在，縮圖改從伺服器取。上傳中或失敗的不保存。
  - 超過 7 天未送出的上傳會被清掉，送出時會收到「attach the file again」。
- **助理對話沒做的原因**：
  - 附件目前掛在任務上，對話要另外加關聯欄位與 migration。
  - 助理的 brain 常是 OpenAI API，是另外建立的，沒包在 provider 表裡。
  - 對話歷史只存文字，非 resume 時要重送圖片。
  - 記憶抽取（`learnFromOwner`）不能碰到附件內容。
  - 建議另開一張票。
- **測試**：
  - db `attachments.test.ts`：連結全有或全無、同一附件只能用一次、型別 CHECK、清理、隨任務刪除、只有已送出的能標成已移除。
  - server `attachments.test.ts`：嗅探、SVG 當文字、base64 後 ≤ 5 MiB、檔名與方向字元、`<id>.<ext>`、別人寫的標記照原文、不同行程的 nonce 不通用、文字只引用一次並包成 reference data、缺檔與已移除、最多 8 張圖與 256 KB 文字、任務累計上限、清理。
  - server `attachments-api.test.ts`（18 個）：上傳驗證與標頭、任務與訊息關聯、只有圖片的 follow-up、steer 帶圖、審查者看到圖、diff 與他任務 prompt 裡的標記照原文、缺檔時警示但照常跑、移除已送出的附件後審查者只拿到名稱、後續訊息附件在清單之後、**大文字附件經 Claude 審查者走 stdin**（真的 `ClaudeCliProvider` 加 fake CLI，任何單一參數都 < 16 KB）、容器模式加 Claude 送圖 422、容器模式文字超過 64 KB 422、真的 git worktree 不含附件。
  - providers：Claude 的 image block、steer 帶圖、長 prompt 走 stdin、容器長 prompt 報錯、容器收圖報錯、檔案不見；Codex `localImage`、`--image`、`exec` 長 prompt 用 `-` 走 stdin、容器長 prompt 報錯、`readFiles` 交給 wrapper；`userMessage` 回聲不記錄；OpenAI `input_image`。
  - web vitest；e2e `attachments.spec.ts`（8 個）。
- **驗證**：見這次的回報。e2e 用不提交的暫時 harness：fake runtime 4398 加 Vite 4173，Vite 的 `/api` 與 `/ws` proxy 都指向 4398，啟動時檢查 proxy 不含 4317／5173；spec 也用 `routeWebSocket` 攔下 WebSocket。`origin-proxy.spec.ts` 寫死 5173，沒跑。第一輪曾有一次 `/ws` 經 Vite 預設 proxy 連到 4317（用 e2e token，被拒），第二輪已排除。
- **沒驗證到（真實 CLI）**：
  - Claude Code 2.1.319 的 `-p --input-format stream-json` 是否真的接受 image block、大圖或高解析度圖是否自己縮小（只依官方 Agent SDK 文件與合成 fake CLI）。
  - Codex app-server `localImage` 是否由 app-server 讀檔、JOY_HOME（sandbox 外）是否讀得到。
  - `codex exec -` 從 stdin 讀 prompt 的實際行為（只依 `--help`）。
  - `codex exec --image` 在容器內以唯讀掛載是否可用。
  - 圖片尺寸（8000 px 上限、超過 20 張時更嚴的限制）沒有在上傳時檢查；被拒時靠擁有者移除那張圖。

### 介面減量：讓介面自己說明（2026-11-14，分支 `ui-declutter`）

- 擁有者追加：新任務頁拿掉「需要你處理」與「最近的任務」（與側邊欄重複），首頁只剩角色、標題與輸入框（沒有任務時才有快速開始）。

擁有者覺得介面混亂；原則是「盡量不要有不必要的說明，let the UI do the explanation」，介面要像 Claude Code／Codex。只改 `apps/web`，沒有動 `packages/**`，沒有新 API。

- **側邊欄只有一個「最近」清單**（`components/Sidebar.tsx`、純函式 `recent.ts`）：任務與助理對話混在一起，依最後活動時間（`updatedAt`，沒有就用 `createdAt`；沒有時間戳的排最前、彼此維持原順序）排序，不再分專案或日期組。任務前是專案色點、對話前是對話框線條圖示；執行中的 thinking 小角色、等你的青點、失敗紅點沿用。移除「助理」按鈕、「對話」「任務」標題與「已封存」群組。頂部「新任務」「聊聊」並排，只有當前頁面真的是該頁時才有底色（「聊聊」＝開新對話，所以只在沒有選任何對話時亮；已有的對話是清單的一列）。搜尋框無外框，滑過／聚焦才有底色，`⌘K` 提示更小更淡（手機寬度不顯示）。空狀態只有一行淡色「還沒有任何工作」（此時連「最近」標題都不顯示），不放角色。底部只剩「設定」。
- **已封存、統計、加入專案搬家**：已封存在「設定 → 已封存」（`components/ArchivedPanel.tsx`，可打開、取消封存；封存仍是側邊欄任務列 hover 的按鈕）；統計是「設定 → 統計」（`StatsPage` 改成 `StatsPanel`）；加入專案只在輸入框的專案選單（最下面）與「設定 → 專案」。指令面板同步：新增「聊聊」「設定：統計」「設定：已封存」，移除「助理」「新對話」「統計」；任務項目不再列出已封存的。
- **設定返回鍵**：設定頁左上「← 返回」，回到進設定前的頁面（任務、對話或新任務；`Workspace` 的 `pageBeforeSettings`，沒有就回新任務頁）。Esc 也返回，但輸入框／下拉選單聚焦時、指令面板、加入專案對話框、任何 `role=dialog|menu`、手機抽屜開著時不攔截（純函式 `escapeLeavesSettings`）。
- **新任務頁**：移除「一個 AI 動手做……」說明行與範例 placeholder；建議按鈕只在完全沒有任何任務（含已封存）時顯示，「從 GitHub issue 開始」只在目前專案有 GitHub 網址時出現（`starters.ts`）；輸入框工具列沒有「進階」，改為「做法」選單最下面一項，開出原本的進階面板；模型入口不再顯示「（預設）」，預設只在模型選單的項目標「預設」。
- **刪文字**：全站掃過一遍，只留錯誤訊息、確認對話、不可逆動作提醒與必要操作說明（逐項清單見這次的回報；主要是設定頁各卡片的說明段落、檢查點／計畫卡／變更面板／存取權杖頁的解釋句）。存取權杖頁的 Mac／Windows／Linux 三步驟保留並精簡。選單項目的第二行小字（做法、模型）保留，並縮短。
- **角色**：深色模式拿掉角色下方的黃色橢圓影子（現在像褐色污漬；`.mascot-ground`），淺色保留；角色只在主畫面大面積空狀態（新任務頁、助理空對話、存取權杖頁）出現，側邊欄空狀態、變更面板空狀態、設定的環境檢查標題都不再放。執行中／等你／完成／出錯的狀態角色不變。
- **測試**：新增 vitest `recent.test.ts`（排序、updatedAt、已封存排除、搜尋、無時間戳）、`starters.test.ts`（建議按鈕顯示條件）、`shortcuts.test.ts`（`escapeLeavesSettings`）；新增 e2e `declutter.spec.ts`（單一清單排序、按鈕只在當前頁亮、設定返回鍵三種來源、Esc 與輸入框／面板不衝突、已封存在設定可打開與取消封存、建議按鈕顯示條件、進階在做法選單、無「（預設）」）；其餘 e2e 依新位置更新（`helpers.ts` 新增 `openAdvanced`、設定分類加「統計」「已封存」）。
- 驗證：見這次的回報。5173 / 4317 被擁有者佔用，e2e 用不提交的暫時 harness（Vite 4173＋fake runtime 4399，跑完已刪除）；`origin-proxy.spec.ts` 固定連 5173，沒跑。

### 品牌：角色、配色、專案色（2026-11-14，分支 `brand-mascot`）

- **角色元件**：`apps/web/src/components/Mascot.tsx`。`Mascot`（`mood`：normal／thinking／happy／waiting／error／sleeping、`size`、`label`、`decorative`）照擁有者核准的設計稿 SVG（viewBox 200）重現，漸層 id 用 `useId` 每個實例唯一；thinking 時小球繞行，用 CSS `.mascot-orbit`（3.2 秒一圈）而不是 SMIL，才能被 `@media (prefers-reduced-motion: reduce)` 關掉（已在 Chromium 實測：reduce 時 `animation-name: none` 且 transform 不變，一般時會變）。裝飾用途（旁邊已有文字）傳 `decorative` 變 `aria-hidden`，否則 `role="img"` + 中文 `aria-label`（Joy 思考中／完成了／等你／出錯了／休息中）。`MascotMark` 是小尺寸平塗版（沒有漸層、光暈與後半圈環），青色跟著主題（`--mascot-teal`：淺色 `#14C9B9`、深色 `#2EE6D6`）。
- **套用位置**：側邊欄 brand（`MascotMark` 26px）；新任務頁標題上方 normal 96px；`RunningIndicator`、助理「正在想」、側邊欄執行中／排隊中的任務 → thinking（取代轉圈，輸入框送出鍵忙碌時的小轉圈沒動）；等你核准的動作卡、計畫卡 → waiting，側邊欄這類任務（等你同意、審查有意見、等你核准計畫）右側是深青小點加原本的文字；任務完成 → 結果區一列 happy「任務完成了」；任務失敗卡、連不到伺服器的錯誤提示 → error；側邊欄與助理頁的空狀態、變更面板「還沒有變更」→ sleeping；存取權杖頁、設定「進階」的環境檢查 → normal；助理頁助理訊息頭像 → `MascotMark` 20px。時間軸裡 agent 的回覆沒有角色，仍標模型名。側邊欄失敗任務右側是紅點（完成的不標，照設計稿）。目前開著的任務／對話：左側 2px accent inset 細線，背景維持灰。
- **配色**：介面維持黑白，品牌色只用在角色與需要注意處。`--accent` 淺色 `#0E9C91`、深色 `#2EE6D6`；新增 `--brand-yellow #FCE9A6`、`--brand-yellow-deep #F5C94A`、`--brand-teal #2EE6D6`。**`#0E9C91` 在白底只有 3.4:1，不到 4.5:1**，所以文字改用新增的 `--accent-text`（淺色 `#07726A`，在 `#FBFBFA`／`#F3F3F1`／hover `#E9E8E4` 上 5.6／5.2／4.7:1；深色同 `--accent`，約 9–11:1）；`--accent` 只用在線條、圓點、焦點外框、填色這類非文字處（需 3:1）。`--accent-soft` 淺色 `#E6F4F3`、深色 `#1A3834`（上面的 accent-text 約 5:1／8:1）。送出鍵維持黑底白字（深色白底黑字）；輸入框有焦點時外框 accent 加 3px 青色淡暈；紅綠狀態色不變。「等你同意」「審查有意見」的狀態點、狀態藥丸、計畫卡改成 accent（原本是琥珀與紫色）；等你同意的動作卡仍是琥珀底。
- **專案色**：6 色 `#7C93B5 #7FA58E #9A8BB8 #C39A74 #BE8E9E #6FA6A8`（灰藍 灰綠 灰紫 灰橘 灰粉 灰青），id 是 `blue green purple orange pink teal`。預設依專案在清單裡的順序輪流（伺服器依建立時間排序、專案不會被刪，所以一個專案的顏色不會變；後面加專案也不影響前面的）。可在「設定 → 專案」的「代表色」改，選「自動」回到輪流配色。db migration 20：`repos.color TEXT NULL`，`CHECK` 限 6 個 id；`updateRepoColor`；`PATCH /api/repos/:id` 接受 `color`（6 個 id 之一，`null` 回自動，其他一律 400）。只用在小圓點：側邊欄任務前、新任務頁「專案 · 分支」入口與選單、任務頁標題旁、設定頁專案卡片，不當文字色。web 與 db 各有一份 6 個 id，`repo-colors.test.ts` 比對兩者相同。
- **圖示**：`apps/web/public/icon.svg`（平塗小圖示、透明底，青色在深色模式自動換 `#2EE6D6`，當 favicon 與 manifest 的 `any`）；`app-icon-maskable.svg`（滿版 `#FFF7DC` 底，角色約 80% 在安全區內）；`app-icon.svg`（同一圖加圓角，給不裁切的地方）。PNG 由 `scripts/render-icons.mjs` 用 Playwright 已裝的 Chromium 產生（不加相依套件）：`icon-192/512.png`（any）、`icon-maskable-192/512.png`（maskable）、`apple-touch-icon.png`（180，滿版，因為 iOS 自己裁切、透明處會變黑）；通知圖示也改用 `icon-192.png`。manifest 的 `any` 與 `maskable` 分開宣告。改了 SVG 之後重跑：`pnpm exec node scripts/render-icons.mjs`。
- **圖示來源與日後替換**：所有角色與圖示都是 agent 依擁有者提供的參考圖（設計稿 `Mascot.dc.html`、`Icons.dc.html`）用 SVG 重繪，不是設計師的原始向量檔。日後要整組換掉：改 `Mascot.tsx`（六種表情與小圖）、`public/*.svg` 後重跑 `render-icons.mjs`、`styles.css` 的 token 與 `repo-colors.ts` 即可，沒有別的地方寫死顏色。
- **順手修正**：設定頁儲存專案後，前端原本把回傳的 repo「合併」進舊的，清掉欄位（`null`）後舊值會留著（例如清掉檢查指令後表單仍認為有變更）；改成直接用回傳的整份 repo 取代。
- **e2e 基礎設施**：`startFakeJoyRuntime(port, { allowPlaywrightOrigin })` 多一個選項，讓 e2e 可用 4390（API）＋4173（Vite）暫時埠跑，不碰擁有者的 4317 與 5173；預設行為不變。
- **驗證**：db、server、web 單元測試（Mascot 各表情、reduced motion、專案色分配與 db 對照、PATCH 驗證）、`brand.spec.ts` 與 `repo-settings.spec.ts` e2e、全部 e2e（暫時埠，`origin-proxy.spec.ts` 因為寫死 5173 沒跑）、淺色／深色／手機寬度截圖。

### 不用終端機：單一程式＋背景服務（2026-11-13）

- **審查修正（同日）**：(1) 保留中的訊息在任務無法接續（沒有 session、worktree 已移除、compete）時立刻撤回並附原因，`/discard`、`/worktrees/remove`、PR 合併或關閉後清掉 worktree 時也撤回並解除保留，不再永遠卡住；(2) 自己的 Origin 只在「連到本機 listener 的那個埠、且對端 localAddress 為 loopback」時放行，remote listener 與其他埠不放行；(3) `budgetStop` 只在任務最後真的是 failed 時才採用，另有兩個任務並行、只有一個被月預算拒絕的隔離測試；(4) 介面過期判斷也看 `packages/core`、`packages/config`，且不跟隨 symlink；pnpm dlx 快取的 `dlx/<hash>/` 路徑也算暫存；其餘文案與跳脫修正（`$` 只在 ExecStart 跳脫、路徑不得含換行、`--dry-run` 文案、port 插值）。
- **單一程式**：`pnpm joy build-ui` 建好 `apps/web/dist` 後，`pnpm joy start` 的伺服器直接提供網頁，開 `http://127.0.0.1:4317`（或 `http://localhost:4317`）就是完整介面，不需要 `pnpm web`。伺服器開始監聽後，把**自己的** `http://127.0.0.1:<實際埠>` 與 `http://localhost:<實際埠>` 加進 Origin 允許清單（之前只允許 5173 的 Vite 與 Tauri，打包介面的 POST 與 WebSocket 會被 403）；其他埠、https、`[::1]` 一律照舊 403。Host 檢查、`sec-fetch-site`、token 驗證都沒動。`pnpm joy start` 會檢查 `apps/web/dist` 是否缺少或比原始碼舊（`packages/server/src/ui-build.ts`），並提示 `build-ui`。打包介面不內嵌 token（build 時 token 是空字串），第一次開會出現既有的存取權杖畫面，現在附上 Mac／Windows／Linux 找到 `~/.joy/api-token` 的步驟。
- **背景服務**：`pnpm joy service install|uninstall|status [--node <path>] [--port N] [--dry-run]`（`packages/server/src/service.ts`）。macOS 寫 `~/Library/LaunchAgents/com.joy.local.plist`（RunAtLoad、KeepAlive，log 導到 `~/.joy/logs/service.{out,err}.log`），用 `launchctl bootout`／`bootstrap gui/<uid>`；Linux 寫 `~/.config/systemd/user/joy-local.service` 並 `systemctl --user enable`＋`restart`；Windows 用工作排程器 `joy-local` 的登入觸發（以 XML 匯入，才能設工作資料夾、取消預設的 72 小時執行上限、失敗自動重啟；以 `conhost.exe --headless` 啟動避免黑色視窗）。launchd `ThrottleInterval` 與 systemd `RestartSec` 都是 30 秒。**Windows 限制**：工作排程器帶不了 PATH／`JOY_HOME`，服務用登入時的使用者環境，install 會印出這點與「`conhost --headless` 尚待實機驗證」；服務名稱刻意用 `joy-local`，不覆蓋同名無關項目。一律不經 shell、參數陣列、`node:path`；安裝前印出將寫入的檔案內容與將執行的指令，`--dry-run` 只印不做。plist／unit 只放 Node 絕對路徑、`--import tsx`、`scripts/joy.ts start --port N`、工作資料夾、PATH（安裝當下終端機的 PATH，去掉 `node_modules/.bin` 與 npx 暫存資料夾，因為 launchd 不會帶終端機的 PATH，而 Joy 要以名字啟動 `claude`／`codex`／`git`／`gh`）與（若有）`JOY_HOME`，**不複製其他環境變數、沒有任何密鑰**（macOS／Linux；Windows 見下）。重跑 install 時若回應的是已安裝的服務會直接重新啟動，不再叫人先停掉。
- **Node 22**：服務必須指向長期存在的 Node 22.x（22.13 以上、23 以前，`.nvmrc` 為 22；擁有者的系統 Node 25 不支援）。順序：`--node <絕對路徑>`（必須能執行 `--version` 且是 22.13+）→ 目前執行的 Node（若不在 npx／pnpm dlx 暫存、是支援版本）→ 搜尋 Homebrew `node@22`、nvm、fnm、asdf、系統資料夾。用 `npx -y -p node@22` 執行時，目前的 Node 在 npx 暫存裡不會被採用；找不到時印中文指示（`brew install node@22` 或 `--node`）。
- **上限停下後排隊訊息不自動接續**：run 因每任務時間上限、每任務 API 花費上限（`stoppedFor`）或 OpenAI API 月預算（`assertMonthlyBudget` 拒絕執行，用 `AsyncLocalStorage` 把拒絕對應回任務）而結束時，排隊訊息保持 queued，發 `user.message.held {ids, reason}`，不再自動 follow-up（含 steer 失敗退回排隊後的 `followUpWhenFree`）。擁有者按「繼續」（`/resume`，run 開始時依 `next_turn` 取走排隊訊息）或再送一則訊息（follow-up，`takeQueuedMessages`）時一併送出；任一個新 run 開始就解除保留。正常完成、失敗、取消、核准逾時暫停、額度排隊等其他結束原因的既有行為不變（取消仍撤回）。前端：訊息顯示「已停下，等你繼續」，輸入框上方一行說明「任務因上限停下，按「繼續」或再送訊息才會帶給 agent」，時間軸有對應事件文案。
- 驗證：`pnpm check` 的 format、lint、typecheck 通過；測試 834 通過、1 個 `packages/executor` 的 worktree 測試在整批平行時逾時（與本次無關，單獨重跑 29 項全過）；新增 server 測試（thread-api：時間上限停下後不自動接續、follow-up 與 resume 會帶上排隊訊息、review loop、月預算、取消仍撤回、其他原因照舊自動接續；server：自己的 Origin 通過、其他埠／https／`[::1]` 403）、`service.test.ts`（三個平台的檔案內容與指令、Node 搜尋、假 runner 的 install／uninstall／status、暫存資料夾實檔）、web 測試。另用真實伺服器（臨時 `JOY_HOME`、埠 4999，不是 4317／5173）確認：打包介面首頁 200、同源 POST 在 `127.0.0.1`／`localhost` 通過、其他 Origin 403、WebSocket 升級過了 Origin 檢查（未知任務 404）、瀏覽器載入打包介面並通過存取權杖畫面。**沒有**真的執行 launchctl／systemctl／schtasks，Windows 的 XML 與 macOS 的 launchd 行為尚待擁有者實機驗證。

### 執行中插話改為即時補充（steer，不打斷 agent）

擁有者不要 #132 的「打斷再接續」當預設。現在任務執行中送訊息，預設**直接交給正在工作的實作者，agent 不停下來**，邊做邊參考（是問題就先簡短回答再繼續）。#132 的中斷機制保留，只在 `POST /messages` 明確帶 `interrupt: true` 時使用。

- **core 介面（擁有者待審）**：`RunOptions` 加可選的 `onSteer?: (steer: Steer | undefined) => void`，新型別 `Steer = (text) => Promise<boolean>`。provider 能接受補充時呼叫 `onSteer(fn)`，不能再接受時呼叫 `onSteer(undefined)`；不支援的 provider（Codex `exec --json`、OpenAI API、容器 repo 的 Claude）從不呼叫，等同「沒有這個能力」。沒有改 `ProviderCapabilities`、`AgentProvider`。
- **Codex app-server**：`turn/start` 回應的 `turn.id` 拿到後提供 steer，送 `turn/steer {threadId, expectedTurnId, input:[{type:'text', text, text_elements:[]}]}`（schema 以本機 codex-cli 0.166.0 的 `codex app-server generate-json-schema` 確認：三者必填，回應 `{turnId}`；不是 experimental 方法）。回錯誤（例如 turn 已結束、`expectedTurnId` 不符）就回 false；`turn/completed` 後、或 run 結束時撤回 steer。`exec` fallback 不提供。
- **Claude Code**：只有呼叫端給 `onSteer`（也就是實作者的 run）才改用 `--input-format stream-json`：prompt 不再放命令列，而是 stdin 第一則 `{"type":"user","message":{"role":"user","content":…},"parent_tool_use_id":null}`；擁有者訊息是之後的同格式 JSONL。**第一個 `result` 出現就關 stdin**，之後的 steer 回 false；CLI 收到 EOF 後仍會處理已收到、排隊中的訊息再結束（官方 streaming input 文件的範例即是產生器結束後兩則都有回覆）。parser 的 `multiTurn` 模式：**第一個 `result` 是任務本身的工作，決定 run 成功或失敗**；之後的 `result` 是 CLI 把擁有者訊息排成另一輪的回覆，它失敗只發 recoverable 的 `error`（「Claude Code could not finish the turn for the owner's added message: …」，時間軸看得到），不推翻已完成的工作；它成功只在工作本身成功時更新最後訊息；工作失敗時後面成功也不會翻成成功。撞到額度照舊由 `rate_limit_event` 轉成的 `quota` 事件處理。`usage` 只在行程結束時發一次、取最後一個 `result`（假設 `total_cost_usd`／`usage` 是累計，**未驗證**；絕不相加），`done` 也延到行程結束；行程被取消／逾時則照舊回失敗的 `done`。審查者、助理、其他角色仍是原本的一次一行程 `-p … -- <prompt>`。stdin 的 JSONL 用 `JSON.stringify` 並另外跳脫 U+2028／U+2029（有些逐行讀取會把它們當換行），換行、引號、控制字元都有測試。
- **容器模式**：server 對 Claude provider 一律傳 `wrap: containerWrap`（非容器 repo 時原樣回傳）。provider 新選項 `forwardsStdin(cwd)` 決定這次 run 的 stdin 能不能送到 CLI；server 傳 `(cwd) => !containerRepoFor(cwd)`：容器 repo 不 steer（`docker run` 沒有 `-i`），其他 repo 照常 steer。有 `wrap` 卻沒給 `forwardsStdin` 時保守不 steer。**8ee77a6 的錯誤**：當時用 `!this.wrap` 判斷，正式環境的 Claude 永遠不 steer，加上預設改成不打斷，比 main 退步；已用 server 自己建立的 provider（`providers.claude.command` 指向假 CLI 的 shell 腳本，POSIX 才跑）測試鎖定，拿掉修正時這個測試會失敗。取消（kill process tree）、`--resume`、Windows `.cmd` shim（仍不經 shell、仍用 `resolveCommandCached`）沿用同一個 `runJsonlProcess`，只是 stdin 改成 `pipe`。
- **server 流程**（`postTaskMessage`，`interrupt` 預設改為 `false`）：任務在跑、實作者那一輪正在進行（`implementerTurn`）、狀態 `running`、沒有被取消／上限停下／暫停／打斷、且 run 提供了 steer（`canSteer`）→ 發 `user.message {delivery:'steer'}`，把訊息包上 `steerMessage()`（「擁有者在你工作時傳來這則訊息，你沒有被停下；之後要參考它、優先於先前指示；是問題就先簡短回答再繼續」）交給 steer。**steer 不在 `exclusive` 裡等**：路由立刻回 `delivery: 'steer'`，結果用事件通知（成功 `user.message.delivered {via:'steer'}`；失敗、丟錯或逾時就放進排隊、發 `user.message.requeued {ids, reason:'steer_failed'}`，照舊在下一次實作者動手或結束後 follow-up 送達），慢的後端不會讓其他擁有者動作回 409。
  - **順序**：每個任務一條 steer 佇列（`steerLanes`），一次送一則、照送出順序；佇列中的數量算進 20 則上限。輪到時若已有排隊中的訊息（例如前一則 steer 退回），這則也排隊，不會超前；送出時已有排隊中的訊息，新訊息直接 `delivery: 'queued'`。
  - **逾時**（預設 10 秒，`steerTimeoutMs` 可調）：先退回排隊；原本的 RPC 稍晚回 true 時，若訊息還在排隊就移出並發 `user.message.delivered {via:'steer', late:true}`，不會再送一次；若已經被下一輪拿走才晚到，只記 log（這種情況仍可能送達兩次）。
  - 退回排隊時若 run 已結束，等任務沒有其他動作佔用時再 follow-up（`followUpWhenFree`）。審查、送審前檢查、等待核准、額度排隊、不支援的 provider：照舊排隊、不打斷。`interrupt: true` 走 #132 原路徑（不 steer）。外部內容任務沒有另外的分支：擁有者的訊息仍是 `provenance: 'user'`，任務提出的動作照舊依 `external_content` 分類。
- **steer 的生命週期**：`steerHook(taskId)` 給 single、先規劃、review_loop（只給實作者的 run：規劃、實作、修正；`reviewLoop` 新輸入 `onSteer`）。provider 提供／撤回 steer 時發安靜事件 `steer.available {available}`（讓前端重新讀取 `steerable`）。`GET /api/tasks/:id` 新增 `steerable`；`interruptible` 保留，表示 `interrupt: true` 現在是否會打斷。
- **審查者看得到 steer 的訊息，但只看實作者收到的**：`reviewLoop` 新輸入 `reviewBrief: () => string`，每次審查前重新讀任務說明（server 傳 `taskBrief(task)`）。以前說明在 run 開始時固定，同一個 run 裡補充的指示審查者看不到，會把照指示做的改動當成偏題。`ownerMessages` 只納入已交給實作者的訊息：`delivery` 是 `follow_up`／`replan` 等送出當下就交付的，或 `queued`／`steer`／`interrupt` 且已有 `user.message.delivered`；還在排隊的不算，否則審查者會因實作者沒看過的指示退回（這也去掉了以前實作者 prompt 裡排隊訊息出現兩次的情形）。
- **前端**：輸入框提示依 `steerable`：可即時補充「補充指示或提問，agent 會邊做邊參考」，執行中但不行「訊息會在 agent 下一次動手時送達」。新的送達狀態 `steering`（標「正在交給 agent…」），送達後標「已交給 agent」（所有送達的訊息都標；用「交給」而不是「送達／讀到」，因為只代表 CLI 收下了）；steer 失敗退回排隊時標「排隊中」。時間軸顯示細節：`user.message.delivered {via:'steer'}` 是「訊息已交給 agent，它會邊做邊參考」，`late: true` 是「agent 稍晚才收到訊息，已從排隊中移除，不會再送一次」，`requeued {reason:'steer_failed'}` 是「沒能即時交給 agent，訊息改為等它下一次動手」，`steer.available` 是安靜事件。前端只送 `{text}`（不再暗中依賴打斷）；「停止任務」鍵不變；修 CI 仍送 `interrupt: false`。
- **測試**：providers：Codex `turn/steer` 合成 contract（參數、成功、被拒回 false、turn 結束後回 false、不給 `onSteer` 就不送）；Claude streaming（stdin 內容與旗標、run 中 steer、第一個 result 後關 stdin 並拒收、CLI 把訊息排成下一輪時兩個 result 只有一個 `done`、沒補充時等同一次性 run、取消、`wrap` 時維持舊命令列）。假 CLI：`fake-cli.mjs` 的 `FAKE_MODE=stream`、`fake-codex-app-server.mjs` 的 `steer`／`steer-reject` 模式（都標明是合成、未錄製）。orchestrator：只有實作者拿到 `onSteer`、每次審查重讀 `reviewBrief`。server `thread-api.test.ts` 新增 8 個：steer 送達且 run 未被中止、只有一個 result、`steer.available` 與 `steerable`；連發兩則各送達一次；不支援時排隊不中止；steer 失敗退回排隊並在下一輪送達；steer 進行中 run 結束仍 follow-up；取消與進行中的 steer 競態（取消優先、訊息撤回）；review_loop 實作中 steer、審查中排隊、審查者沒有 `onSteer` 且說明含補充；`interrupt: true` 在可 steer 時仍打斷。原本 #132 的 12 個打斷測試改成明確送 `interrupt: true`。web vitest（`messages`、`timeline`、`useTaskDetails`）與 e2e `thread-api.spec.ts`（「執行中送訊息會在 agent 工作時送達」、審查中排隊、送達標「已交給 agent」）。
  - 審查後補的測試：providers：`forwardsStdin` 為 true 時經 wrap 仍 steer；多輪下第二輪失敗只發 recoverable error、`done` 仍成功；第一輪失敗、第二輪成功仍是失敗；`usage` 只發一次、取最後一個（不相加）；`claudeUserMessage` 對換行、`\r`、引號、反斜線、NUL、ESC、tab、U+2028 都是一行且原樣還原；streaming 命令列不含 prompt。server：用 server 自己建立的 Claude provider（非容器 repo）steer 成功、stdin 收到第二則；逾時後原 RPC 晚回 true → 移出排隊、`late: true`、不 follow-up；逾時且沒回 → 下一輪送達；steer 很慢時第二則訊息與 PATCH 都不會 409，且照順序送；前一則逾時退回時後面的也排隊、follow-up 的 prompt 照順序；review_loop 中排隊未送達的訊息不給第一輪審查者、修正輪與第二輪審查才有。
- **沒驗證到（真實 CLI）**：(1) Claude Code 在 `--input-format stream-json` 下，turn 進行中收到的使用者訊息是在工具呼叫之間插入、還是排成下一個 turn（兩種都已用假 CLI 涵蓋，但真實行為只有第三方資料，官方文件只寫 queued messages 依序處理）；(2) EOF 後 CLI 是否一定處理完已收到的訊息才結束（依官方範例推論）；(3) 多輪時 `result.total_cost_usd`／`usage` 是累計還是單輪（目前只取最後一個 result；若其實是單輪，前面幾輪的估計會少算；Claude 訂閱不計費，不影響上限）；(4) Codex `turn/steer` 的真實回應與事件只依 schema。需要擁有者用 `scripts/record-fixtures.mjs` 錄製後再確認。

### 執行中插話會打斷目前這一步（#132；現在只在 `interrupt: true` 時）

> 2026-11-09 起不是預設，見上一節。以下是 #132 當時的說明。

擁有者在任務執行中送的訊息，以前要等下一輪才送達；現在預設**打斷實作者目前這一輪，同一個 worktree、同一個 session 帶著訊息接續**（跟 Claude Code／Codex 的體驗一樣）。沒有改 `packages/core`、`packages/policy`。

- **什麼時候打斷**（`server.ts` 的 `canInterrupt`）：single／review_loop 任務、任務狀態是 `running`、實作者那一輪正在跑（`ActiveTask.implementerTurn`：single 與先規劃的 provider 迴圈；review_loop 看 `phase` 事件，`planning`／`implementing`／`fixing` 開、實作者的 `done` 或審查階段關）、attempt 已有 session id 與 worktree、provider 支援 resume。其他情況照舊排隊（`delivery: 'queued'`）：等待核准（`awaiting_approval`）、額度排隊（`queued`）、被時間／花費上限停下、正在取消、審查、送審前檢查、建立 worktree、尚未拿到 session id。`POST /messages` 加 `interrupt?: boolean`（預設 `true`），`false` 就是舊的排隊行為；前端只用預設。
- **審查中不打斷**：審查者是另一個模型、另一個 session，擁有者的指示是給實作者的，審查者拿到也不能照做；打斷審查會丟掉對已完成工作的意見，實作者接續時就沒有這份意見；審查唯讀、通常比實作短。所以審查與送審前檢查期間訊息排隊，在下一次實作者動手時送達（審查要求修改就是修正輪，審查通過就是結束後立刻 follow-up）。
- **流程**：訊息先放進 `queuedMessages`，發 `user.message {delivery: 'interrupt'}`，設 `active.interrupted` 並 abort 這次 run 的 `AbortController`（與取消同一條路徑）。run 收斂時（single、先規劃、review_loop 的 `result: cancelled`，或 provider 直接丟錯的 `runTask` catch），`interruptPending` 為真就不把任務標成 cancelled、不發 `result`，改發 `run.interrupted {reason: 'owner_message'}`（也算 run 結束，用量的 durationMs 會切開），把 attempt／worktree／session 記在 `active.continueWith`。`scheduleTask` 的 finally **同步地**取走全部排隊訊息並以同一 session 排下一次 run；訊息在接續的 run 真的要交給 agent 時（provider 啟動前一刻、review_loop 的實作者階段開始時）才發 `user.message.delivered {via: 'interrupt'}`，接續的 run 在那之前就失敗（例如專案不再允許該 provider）則改發 `user.message.discarded`（計畫未核准時是 replan、仍唯讀），中間沒有 await，其他擁有者動作插不進來。任務狀態一路維持 `running`。
- **接續提示**（`@joy/orchestrator` 的 `interruptedPrompt`）：說明前一步被擁有者打斷、可能做到一半、要先看檔案；訊息優先於先前指示，是問題就先回答再繼續；先規劃時另外說明還不能改檔案。review_loop 接續時審查者看到的任務說明照舊含擁有者的每一則訊息；被打斷的那一輪不會被審查。
- **競態**：連發多則：第一則打斷後、run 收斂前的訊息都標 `interrupt`、不再 abort，同一次接續一起送達，每則只送達一次。插話與 `/cancel`：`cancelTaskById` 設 `active.cancelled`，取消優先；run 照取消收尾，排隊訊息 `user.message.discarded`（標「已撤回」）。若 `continueWith` 已設才收到取消（理論上不會發生，因為兩者之間只有 microtask），finally 把任務收成 cancelled 再丟棄訊息。插話時 run 正好自然結束：實作者那一輪已結束就不打斷、照舊排隊（結束後 follow-up）；abort 剛好落在最後一個事件之後，仍照打斷處理並接續。Joy 關閉時不接續（重啟後照舊是 `interrupted`）。
- **時間與輪數不重算**：打斷後接續的 run 沿用被打斷那次的截止時間（`budget.per_task.max_minutes`），只用剩下的時間；review_loop 只給剩下的輪數（被打斷的那一輪重做，只算一次）。擁有者的 follow-up 仍從頭算。
- **沒打斷成**：打斷還沒收斂就被時間／花費上限停下（或核准逾時暫停）時，那些訊息發 `user.message.requeued {ids}` 回到排隊（前端改標「排隊中」），之後照舊在下一輪或 follow-up 送達。
- **已知限制**：被打斷那一輪做到一半的檔案留在 worktree，不另外建立檢查點。
- **前端**：`GET /api/tasks/:id` 多了 `interruptible: boolean`（現在送訊息會不會打斷）；只有它為 `true` 時輸入框提示才是「傳訊息會打斷 agent 目前這一步，帶著訊息繼續」，執行中但在審查、檢查或準備時是「訊息會在 agent 下一次動手時送達」，舊伺服器沒有這個欄位時也用這句（等待核准／額度排隊仍是「補充指示，下一輪會帶給 agent」）。`phase`、`started`、`checks`、`run.interrupted`、實作者的 `session_started`／`done` 事件會觸發重新讀取。「請 agent 修正 CI」送 `interrupt: false`，不打斷 agent；`delivery: 'interrupt'` 的訊息在送達前標「正在打斷 agent…」，輸入框上方說明「正在打斷 agent 目前這一步，停下來後會帶著你的訊息繼續」；排隊訊息的說明加上「審查、檢查與等待核准時不會打斷」。時間軸：`run.interrupted` 是淡色步驟「已中斷目前這一步，帶著你的訊息繼續」，`user.message.delivered {via: 'interrupt'}` 在顯示細節裡是「已打斷 agent，訊息已交給它」。輸入框空白時的停止鍵不變。
- **測試**：`thread-api.test.ts` 新增 7 個（打斷 single 並以同一 session 接續、prompt 含訊息、只有一個 `result` 且不是 cancelled、連發兩則各送達一次、取消優先且訊息撤回、打斷 review_loop 實作者後審查接續的工作、審查中不打斷、先規劃中打斷仍唯讀並停在等核准、`interrupt: false` 排隊與參數驗證），第二輪再加 6 個（provider 被停下時直接丟錯的 `runTask` catch 路徑、修正輪被打斷只給剩下的輪數（`maxRounds: 2` 總共審 2 輪）、每 250ms 插話仍在 400ms 上限停下、上限先到時訊息 `requeued` 後照舊 follow-up、接續的 run 因 provider 不再允許而失敗時訊息撤回、`interruptible` 在實作中／審查中／結束後的值）；原本測排隊行為的 4 個測試改送 `interrupt: false`。web vitest：`messages`（`interrupting`、`requeued`、依 `interruptible` 的提示）、`timeline`（新事件）、`useTaskDetails`（`interruptible` 與重新讀取的事件）。e2e `thread-api.spec.ts` 新增「執行中送訊息會打斷」、更新提示文字、檢查修 CI 送 `interrupt: false`。
- 驗證（審查後修正）：`pnpm check` 通過（格式、lint、typecheck；vitest 766 passed、4 skipped），`thread-api.test.ts` 中斷相關 13 個全過；e2e 受影響的 `thread-api`、`thread`、`shell` 25 個全過。第一輪：vitest 758 passed、4 skipped，`thread-api.test.ts` 30/30。因為 5173 / 4317 被擁有者佔用，e2e 用不提交的暫時 harness 在 5199 / 4399 跑（proxy 改寫 Origin），55 個測試全過（略過固定連 5173 的 `origin-proxy.spec.ts`）；最後仍以 CI 的 web E2E 為準。
- **沒驗證到**：真實 Claude Code／Codex CLI 被 abort 後再 `--resume` 的行為（session 是否保留被打斷那一輪的部分內容、工具呼叫做到一半時的狀態）只用假 provider 驗證；等待核准中送訊息照舊排隊的路徑沒有專門的測試（沿用 `status === 'running'` 判斷）。

### 新任務頁輸入框工具列與模型選單（前端）

只改 `apps/web`，沒有動 `packages/**`、後端與 API。

- **工具列**：四個有外框的下拉改成無外框的 ghost 入口（滑過才有底色），都用新的共用選單：左邊「專案 · 分支」（選單末有「加入專案」），中間「做法」（合併模式與先規劃，顯示「實作＋審查 · 先規劃」；先規劃是選單裡的核取項，兩家比賽與自訂流程時停用並寫原因），右邊緊貼送出鍵的模型入口，直接顯示實際模型與投入程度（「Opus 5.5 · 中」）。沒選過時顯示設定檔解析後的模型並標「（預設）」。「進階」（逐角色的服務／模型／思考程度欄位）保留，變成圖示加文字的 ghost 鈕。窄螢幕（< 640px）做法與進階收成圖示、「（預設）」隱藏，工具列不會水平捲動。自訂流程使用自己的模型，模型入口停用並顯示「自訂流程」。
- **模型選單**（`components/ComposerMenus.tsx`）：上半是實作模型（`models.ts` 的目錄：Opus／Sonnet／Haiku 5.5、GPT-6.1 Sol、GPT-6 Luna；顯示名稱、簡稱、說明集中在這張表，`labels.ts` 的 `MODEL_SUGGESTIONS` 改由它衍生），打勾標目前選擇、右側 1–5 快捷；專案的 `allowedProviders` 不允許的 provider 停用，第二行與 tooltip 寫原因。中間「投入程度 ›」（開啟投入程度 popover）與「審查模型 ›」（子選單，單人模式停用）。下半「快速套用」：照設定／平衡／省額度／最強，每項第二行寫實際組合（「Opus 中 實作 · Sol 審查」）。設定檔裡不在目錄的模型（例如 `claude-opus-4-6`）照原名顯示並勾選。
- **投入程度 popover**（`components/EffortPanel.tsx`）：標題是目前檔位（低／中／高／很高／最高，沿用設定頁的 `EFFORT_LABELS`，共五檔，對應 `EFFORTS`），下一行可點的模型名稱（點了回到模型清單、焦點在已勾選的模型），五段滑桿（拖曳、點段落、方向鍵、Home／End、數字 1–5），右上「重設」回到預設檔位。目前模型不支援的檔位變灰、不能選（Codex 模型沒有「最高」）；沒驗證過的模型整條停用並說明，送出時不帶 effort。
- **共用選單**（`components/Menu.tsx`）：`Menu`／`MenuItem`／`MenuGroup`／`MenuSeparator`／`SubMenu`；內距 6px、項目最低 32px、與觸發鈕 4px、陰影無外框（新 token `--menu-surface`、`--menu-shadow`，深淺色都有）。面板用 portal 放在 `<body>` 並以 fixed 定位（`menu-position.ts` 的純函式：優先方向、空間不夠時翻面、子選單右側放不下改左側、一律限制在視窗內），不會被父層 overflow 裁掉。鍵盤：上下鍵、Home／End 移動，Enter／空白選取，數字鍵選有該快捷的項目，右鍵開子選單、左鍵或 Esc 關子選單，Esc 關主選單並把焦點還給觸發鈕，Tab 關閉；點外面關閉但不搶焦點。ARIA：`menu`／`menuitem`／`menuitemradio`／`menuitemcheckbox`／`group`／`separator`，子選單列有 `aria-haspopup`／`aria-expanded`，停用的項目用 `aria-disabled`（仍可用鍵盤移到上面，能讀到原因）。其他頁面的 `Popover`（用量、檢查點）是內含按鈕與表單的對話面板，不是選單，沒有遷移，仍用原本的元件。
- **送出內容**（`composer-choice.ts`）：沒選任何東西就不送 `roleOverrides`（以前會把解析後的實作／審查模型整組凍結進任務），由伺服器照設定解析；選了才只送被選的角色（`implementer`、`reviewer`），單人模式不送 `reviewer`，自訂流程只送 `workflow`。不送 `orchestrator`：任務執行路徑不使用這個角色（只在換手與 peer 的候選順序裡出現），所以「跟隨實作者」沒有意義。選到與設定完全相同的模型與投入程度時視為「照設定」。換模型時沿用目前的投入程度，新模型不支援就移到最接近的檔位。
- **記住選擇**：模型、投入程度、審查模型、做法、先規劃存在 `localStorage['joy.composer.v1']`（讀寫都包 try/catch；壞掉或過期的內容丟掉該欄位用預設，例如記住的 OpenAI API 實作者、已不存在的自訂流程、模型不支援的檔位）。專案不允許的記憶選擇只在畫面與送出時略過，不會被覆寫。選單的「照設定」把模型選擇全部清掉；投入程度的「重設」只把投入程度回到預設（設定檔的檔位，或換了模型時用 medium）。
- **後端資料**：設定檔各角色的預設模型可從 `GET /api/config`（`config.roles`）讀到，已用來顯示「（預設）」；專案的 `allowedProviders` 在 `GET /api/repos`。effort 相容規則：web 不依賴 `@joy/model-effort`（會動 `pnpm-lock.yaml`，超出這次的範圍），改在 `effort.ts` 複製那張表，`effort.test.ts` 逐一比對兩邊對每個模型與每個 effort 的判斷，不一致會測試失敗。
- 純函式都有 vitest（`models`、`effort`、`composer-choice`、`menu-position`）；e2e 新增 `composer-model.spec.ts`（預設標示、鍵盤操作、ARIA、投入程度滑桿的鍵盤／滑鼠／拖曳／灰階檔位／重設、審查模型、快速套用、`allowedProviders` 停用、單人模式、記住選擇與照設定、壞掉的記憶、設定檔手動模型、手機寬度；送出的 `roleOverrides` 內容用 route mock 逐一比對），並更新 `shell`、`t1.8`、`workflows` 三個規格。
- 驗證：`pnpm check` 的格式、lint、typecheck 通過，vitest 743 passed、4 skipped；唯一失敗的是與這次無關的 `packages/executor` `worktree.test.ts`「commits with a fallback identity」（機器忙碌時超過 5 秒 timeout），單獨重跑 executor 29/29 通過。因為 5173 / 4317 被擁有者佔用，e2e 用不提交的暫時 harness 在 5199 / 4399 跑（proxy 改寫 Origin）：54 個測試（略過固定連 5173 的 `origin-proxy.spec.ts`）全過，其中 `composer-model.spec.ts` 12 個。淺色、深色、手機寬度（375px）都用截圖檢查過選單、投入程度與工具列。最後仍以 CI 的 web E2E 為準。

### 介面改版第二階段：設計語言統一與任務頁補強

- 擁有者審閱後認為設計語言不一致，這一輪統一：圓角（6 / 10 / 14 / 20，只有狀態標籤用膠囊）、字級（12 / 13 / 14 / 15 / 18 / 22 / 28）、字重（400 / 500，大標題才用 600）都改成 CSS token，移除 9 / 10 / 11px；按鈕只有 primary / secondary / ghost / danger 四種（高度 34px、大型 40px），危險動作（移除、刪除、丟掉變更、拒絕）用 danger；圖示統一成一組內嵌 SVG（取代 emoji 與 ×、＋、↗）。
- 新任務頁與助理頁共用同一個輸入框元件：Enter 送出、Shift+Enter 換行（輸入法組字中不送出），未送出的草稿依頁面存在 localStorage。任務紀錄與助理對話共用同一種訊息呈現：使用者的話靠右氣泡，agent 與助理的話是 Markdown 散文。Markdown 用自己寫的小型解析器（`markdown.ts`），產出資料樹再由 React 轉成元素，不使用 `dangerouslySetInnerHTML`；原始 HTML 只會當文字顯示，連結只保留 http(s) 與 mailto。
- 助理頁不再有第二個側邊欄：對話移到主側邊欄的「對話」群組（含「新對話」），側邊欄頂端的搜尋框同時篩選任務與對話；以前對話的全文搜尋留在助理頁上方；記憶與排程收進右側可收合面板。統計移到側邊欄底部（設定旁）。側邊欄的 OpenAI 用量只在本月花費達上限 80% 或有 provider 額度用完時才出現。
- 設定頁改成左側分類：一般（外觀、快速鍵）、模型、權限與自主、通知、專案、資料與備份、進階（環境檢查、存取權杖、除錯紀錄）。模型分類提供三組預設（平衡 / 省額度 / 最強）一鍵填滿六個角色，逐一設定收在「各角色的詳細設定」。主題可選系統 / 淺色 / 深色，寫入 `<html data-theme>`，CSS token 同時支援 `prefers-color-scheme` 與 `[data-theme]`。寬度小於 860px 時側邊欄變成抽屜，頂端有選單按鈕。
- 任務頁：任務進行中有「停止」（`POST /api/tasks/:id/cancel`），失敗或取消（非 compete）有「重試／繼續」（`POST /api/tasks/:id/resume`），失敗時顯示錯誤卡片。標題列顯示該任務實際的分支與工作副本（取自 attempt 的 `branch`、`worktreePath`，可複製），不再把 repo 預設分支當成任務分支。工具呼叫顯示指令（`$ pnpm test`）或檔案路徑，並把後面的 `tool_result` 收成可展開的輸出。審查結果是結構化卡片（通過 / 要求修改、摘要、問題清單）。權限事件 tier 為 auto 的歸入「顯示細節」。執行中顯示目前角色、輪數與經過時間。核准卡片移到時間軸最後。變更面板沒有 diff 時預設收合、diff 出現時自動展開，含依目錄分組的檔案樹與逐行上色的 unified diff；已開的 PR 多一顆「查看 PR」。`review_ready` 顯示為「審查有意見」，顏色與「等你同意」不同。時間軸項目的時間放在 title。
- 側邊欄與新任務頁：任務依專案、今天 / 昨天 / 更早分組，顯示相對時間、執行中轉圈、可搜尋。「封存」已改成後端欄位（見下方「任務對話式介面接線」）。新任務頁加入「模型組合」選擇（同設定頁的三組預設，對應 implementer / reviewer 的 roleOverrides）、快速開始建議、最近的任務，以及有任務等待同意 / 有審查意見 / 進行中時的「需要你處理」。快速鍵：⌘/Ctrl+K 命令面板、⌘/Ctrl+N 新任務、⌘/Ctrl+B 收合側邊欄、⌘/Ctrl+\ 變更面板（輸入文字時只有 ⌘K 生效）。
- 未做：新任務頁的「基底分支」（API 還不支援）。
- `main.tsx` 拆成 `Workspace.tsx`、`pages/`、`components/`、`hooks/` 與數個純函式模組（`markdown.ts`、`tool-calls.ts`、`timeline.ts`、`task-info.ts`、`diff.ts`、`dates.ts`、`presets.ts`、`shortcuts.ts`），新增的純函式都有 vitest 單元測試。
- 驗證：`pnpm check` 通過（格式、lint、typecheck、vitest）。e2e 規格已依新的分類與標籤更新，並新增 `thread.spec.ts`、`shell.spec.ts`。因為 5173 / 4317 被擁有者的 dev server 佔用，沒有用專案的 Playwright 設定在本機跑；改用不提交的暫時設定與 harness 在 5199 / 4399 跑過 25 個測試（`origin-proxy.spec.ts` 固定連 5173，沒跑），全部通過，最後仍以 CI 的 web E2E 為準。深色模式與手機寬度只用瀏覽器面板抽查，沒有逐頁視覺比對。

### 任務對話式介面接線（前端）

把「任務對話式 API（後端）」那一節的端點全部接到 `apps/web`，沒有改 `packages/**`。

- **接續／插話**：任務頁底部是共用的 `Composer`（`ThreadComposer`），送出 `POST /api/tasks/:id/messages`。`user.message` 事件是時間軸裡靠右的氣泡；`delivery: queued` 的訊息在收到 `user.message.delivered` 前標「排隊中」，`user.message.discarded` 標「已撤回」，Joy 重啟後伺服器已不記得的排隊訊息標「未送達」（純函式在 `messages.ts`）。`queuedMessages` 顯示成輸入框上方的一行說明。輸入框提示依狀態變：執行中「補充指示，下一輪會帶給 agent」、已結束「接著交代…」、計畫待核准「說明要怎麼改計畫」；compete 任務與工作副本已移除時停用並說明原因。409（另一個動作進行中）顯示「這個任務正在處理另一個動作，請稍後再送」、429 顯示排隊太多，兩者都保留草稿。
- **先規劃**：新任務頁輸入框的「先規劃」切換鈕送出 `planFirst: true`（兩家比賽與自訂流程停用）。`details.pendingPlan` 有值時，時間軸最後出現計畫卡片（Markdown 計畫、計畫審查摘要、「核准並開始實作」→ `/plan/approve`、「取消任務」→ `/plan/reject`）；這時送出的訊息改寫計畫。`plan.awaiting_approval`／`plan.approved`／`plan.rejected` 都在時間軸上（過去版本的計畫可展開）。有待核准計畫的任務狀態顯示「等你核准計畫」。WebSocket 收到相關事件後會重新讀 `usage`、`pendingPlan`、`queuedMessages`（`hooks/useTaskDetails.ts`）。
- **封存／重新命名**：封存改用 `PATCH /api/tasks/:id {archived}`，任務清單用 `GET /api/tasks?archived=1` 一次取回全部、依 `archived` 分到「已封存」區（執行中封存會回 409，顯示中文訊息）。舊的 `joy.archivedTasks` localStorage 在第一次載入時搬到伺服器（只搬還存在且尚未封存的任務），搬完刪掉該 key，相關程式碼已移除。任務標題連點兩下或按鉛筆圖示就地編輯，Enter／離開輸入框儲存、Esc 取消，送出 `PATCH {title}`。
- **PR／CI**：任務有 `publish.done` 時，`GET /api/tasks/:id/pr` 每 60 秒輪詢（頁面可見時；PR 合併或關閉、或所有檢查都結束就停），顯示 Draft／已開啟／已合併／已關閉與「通過 n / 失敗 n / 進行中 n」及失敗的檢查名稱。失敗時有「請 agent 修正 CI」，送出帶失敗檢查名稱的 follow-up 訊息。開 PR 後工作副本會保留到 PR 合併或關閉（`GET /pr` 讀到 `MERGED`／`CLOSED` 時移除並發 `worktree.removed {published:true, pullRequestState}`），所以可以直接請 agent 修 CI；agent 再做事後，PR 列出現「推送更新到 PR」，推到同一個分支、沿用同一個 PR（已不是 draft 也可以）。工作副本已移除時才改成「複製修正 CI 的說明」。
- **專案檢查**：`checks` 事件是時間軸卡片（通過／失敗／逾時、結束碼、耗時、可展開的 `outputTail`），`checks.skipped` 是淡色步驟。設定 → 專案每個專案一張卡片，可編輯 GitHub 網址（`githubRemote`）、允許的服務（`allowedProviders`，至少一個）與送審前檢查指令（`checkCommand`，單行以空白切成 argv，不經 shell；說明哪些指令需要核准），用 `PATCH /api/repos/:id` 只送有改的欄位（清空送 `null`）。
- **檢查點**：任務頁標題列的「檢查點」彈出清單（`GET /checkpoints`，新的在前，標籤翻成中文），「還原到這裡」→ `POST /checkpoints/:n/restore`；回 409 且訊息說會丟掉 commit 時，在頁面內（不用 `window.confirm`）說明「會丟掉之後的 N 個 commit」，確認後帶 `{confirm: true}` 重送。任務執行中停用。`checkpoint.created` 在「顯示細節」，`checkpoint.restored` 是可見步驟，變更面板的 diff 也跟著還原後的內容。
- **用量**：標題列「用量」彈出耗時、輸入／輸出 token、估計花費與各 provider／model 明細；CLI 的花費標「估算」。
- **環境檢查**：移除前端的 `DOCTOR_LABELS`，直接顯示伺服器的中文 `label`／`summary`／`repair`（`repair` 等於「不需要處理。」時不顯示）；doctor e2e 改用中文資料。
- 新的純函式都有 vitest：`messages.ts`、`pr-status.ts`、`checkpoints.ts`、`usage.ts`、`check-command.ts`、`repo-patch.ts`、`timeline.ts` 的新事件、`storage.ts` 的舊封存解析、`hooks/useTaskDetails.ts` 的 `withServerFields`。e2e 新增 `thread-api.spec.ts`（接續、排隊、409、停用原因、計畫核准／取消、PR 狀態、檢查點還原確認、檢查卡片、用量）、`repo-settings.spec.ts`，`shell.spec.ts` 加入伺服器端封存、舊 localStorage 搬移、重新命名、先規劃。

- 驗證：`pnpm check` 的格式、lint、typecheck 通過，vitest 688 passed、4 skipped；web 專案 120 個測試全過。唯一失敗的是和這次無關的 `packages/executor` `worktree.test.ts`「commits with a fallback identity」，在機器忙碌時超過 5 秒 timeout，單獨重跑 24/24 通過。因為 5173 / 4317 被擁有者的 dev server 佔用，e2e 用不提交的暫時設定在 5199 / 4399 跑（vite proxy 改寫 Origin）：43 個測試中 42 通過，唯一失敗的 `origin-proxy.spec.ts` 固定連 5173、被改寫 Origin 的 proxy 影響，沒有意義；最後仍以 CI 的 web E2E 為準。深色模式與手機寬度只用截圖抽查。

### 任務對話式 API（後端）

給新版對話式介面用的後端 API。所有端點都要 Bearer token；POST／PATCH 要 `content-type: application/json` 與允許的 Origin。事件同時寫進 `GET /api/tasks/:id` 的 `events`，並經 WebSocket 推送（payload 一律經 Redactor）。

| 端點                                         | 請求                                                                      | 回應                                                                                                                                                                                                                                                                         | 事件                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /api/tasks/:id`                       | `{title?: string(1–500), archived?: boolean}`（至少一個）                 | 200 `{task}`；執行中封存 409                                                                                                                                                                                                                                                 | `task.updated`（請求內容）                                                                                                                                                                                                                                                       |
| `GET /api/tasks`                             | `?archived=1` 才包含已封存                                                | `{tasks}`，每筆有 `archived: boolean`                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                |
| `GET /api/tasks/:id`                         | —                                                                         | 原有欄位，加上 `usage`、`pendingPlan`（`{plan, review?}` 或 `null`）、`queuedMessages`（`[{id, text}]`）；`attempts[]` 已有 `branch`、`worktreePath`；`task` 已有 `createdAt`、`updatedAt`                                                                                   | —                                                                                                                                                                                                                                                                                |
| `POST /api/tasks/:id/messages`               | `{text: string(1–20000), interrupt?: boolean}`（預設 `true`）             | 202 `{task, message: {id, delivery}}`；`delivery` 為 `interrupt`（打斷實作者目前這一輪，同一 session 接續）、`queued`（任務忙碌但不能打斷，或 `interrupt: false`）、`follow_up`（接續已結束任務）、`replan`（計畫尚未核准，改寫計畫）；compete 任務 409；worktree 已移除 409 | `user.message` `{id, text, provenance: 'user', delivery}`；送達時 `user.message.delivered` `{ids, via: 'interrupt'\|'next_turn'\|'follow_up'\|'replan'\|'plan_approved'}`；打斷時 `run.interrupted` `{reason: 'owner_message'}`；丟棄時 `user.message.discarded` `{ids, reason}` |
| `POST /api/tasks/:id/plan/approve`           | `{note?: string}`                                                         | 202 `{task}`；沒有等待核准的計畫 409                                                                                                                                                                                                                                         | `plan.approved` `{note?}`，接著同一 session 開始實作                                                                                                                                                                                                                             |
| `POST /api/tasks/:id/plan/reject`            | `{note?: string}`                                                         | 200 `{task}`（`cancelled`）                                                                                                                                                                                                                                                  | `plan.rejected` `{note?}`                                                                                                                                                                                                                                                        |
| `GET /api/tasks/:id/pr`                      | —                                                                         | 200 `{url, state, isDraft, checks: {passing, failing, pending, failingNames[]}, fetchedAt}`；沒開過 PR 404；`gh` 失敗 502                                                                                                                                                    | —                                                                                                                                                                                                                                                                                |
| `GET /api/tasks/:id/checkpoints`             | —                                                                         | `{checkpoints: [{n, ref, commit, head, round, label, attemptId, createdAt, available}]}`                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                |
| `POST /api/tasks/:id/checkpoints/:n/restore` | `{confirm?: boolean}`                                                     | 200 `{restored, savedAs, discardedCommits}`；執行中 409；找不到 404；會丟掉之後的 commit 而沒 `confirm` 409                                                                                                                                                                  | 先 `checkpoint.created`（目前狀態另存為新檢查點），再 `checkpoint.restored` `{n, commit, savedAs, discardedCommits, diff}`                                                                                                                                                       |
| `PATCH /api/repos/:id`、`POST /api/repos`    | 新增 `checkCommand: string[]`（argv，不經 shell；PATCH 可用 `null` 清除） | `{repo}`，有設定時 `repo.checkCommand`                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                |

其他新事件：`plan.awaiting_approval` `{plan, review?}`（任務狀態 `review_ready`，同時 `result` 帶 `awaitingPlanApproval: true`）；`checks` `{type: 'checks', round, ok, exitCode, outputTail, durationMs, timedOut?}`；`checks.skipped` `{round, reason}`；`checkpoint.created` `{n, ref, commit, head, round, label}`。

- **接續（follow-up）**：done／review_ready／failed／cancelled 的非 compete 任務，用同一個 worktree 與 provider session 接續，然後照原本的流程再跑一次（review_loop 會再審查；回合編號接在之前之後，最多再跑 `maxRounds` 輪）。審查者看到的任務說明＝原始需求＋擁有者之後的每一則訊息。任務的 provenance 不變（外部內容任務仍照外部內容規則審核）。
- **同一任務一次一個擁有者動作**：傳訊息、核准／拒絕計畫、`/resume`、還原檢查點、`/discard` 共用一個每任務的鎖；同時第二個請求回 409「Another action on this task is still in progress」。await 之後會重新讀取任務狀態與 worktree，有變就 409。已封存的任務被接續時自動取消封存（`task.updated {archived: false}`）。被丟棄的訊息不會出現在之後給審查者的任務說明。
- **執行中插話（steer）的實際語意**（已由上方「執行中插話會打斷目前這一步」取代預設行為；以下是 `interrupt: false` 或不能打斷時的排隊行為）：CLI adapter 無法在一輪中途插入訊息，所以訊息先排隊，**在下一次 agent 輪開始時**附在提示後面送出（review_loop 的修正輪、暫停／額度排隊後的接續）。如果這次執行已經沒有下一輪（例如 single 模式、或審查已通過），執行一結束就自動用這些訊息做一次 follow-up；任務被取消則丟棄並記 `user.message.discarded`。排隊中的訊息只存在記憶體，Joy 重啟會遺失（事件仍在）。
- **送審前檢查**：repo 設定 `checkCommand` 後，review_loop 在每次實作／修正之後、審查之前於 worktree 執行；結果給審查者看，失敗就算審查通過也不算完成，失敗輸出送回實作者當作下一輪修正（受原本回合上限限制）。single 模式只執行並回報、不改變結果。走 executor（不經 shell；container repo 在 agent container 內以 `--init` 執行，每個 repo 有自己的 container home，停止時 `docker kill` 該 container）。policy 動作種類用 `packages/policy` 的 `isSafeWorktreeCommand` 判斷：只有像 `pnpm check`、`npm test` 這種已知只在 worktree 內的指令是 `run_in_worktree`；shell（`bash -c …`）、不認得的程式、或任何含空白或 shell 符號的參數都算 `run_outside_worktree`，要擁有者核准；外部內容任務一律要核准；未核准則略過檢查（`checks.skipped`）。逾時、取消或任務上限會停掉整個 process tree（POSIX 用 process group，SIGTERM 後 2 秒 SIGKILL；Windows 用 `taskkill /T /F`），不等殘留子程序的 pipe。輸出經 Redactor、只留最後 4000 字；預設 15 分鐘逾時。**已知限制**：環境變數是黑名單過濾（名稱結尾 `_KEY`／`_SECRET`／`_TOKEN`、含 PASSWORD／SECRET／TOKEN／CREDENTIAL、`AWS_*`、`GH_*`、`GITHUB_*`、`SSH_AUTH_SOCK`、`DATABASE_URL`），名稱不尋常的機密仍會傳給檢查指令；非 container repo 的檢查在本機執行，不是沙箱。
- **PR／CI 狀態**：`packages/github` 的 `PullRequestStatusReader` 以 `gh pr view <url> --json url,state,isDraft,statusCheckRollup` 讀取（不經 shell、可注入 runner），每個 URL 快取 60 秒，失敗不快取。
- **先規劃（planFirst）**：`POST /api/tasks` 的 `planFirst: true` 可用於 single 與 review_loop（compete 回 422）。實作者先唯讀寫計畫（review_loop 另有審查者審計畫），任務停在 `review_ready` 並帶 `pendingPlan`；核准後在同一 session 實作，傳訊息則改寫計畫。**行為變更**：設定檔工作流程的 `plan_first` 也一樣會停下來等核准（以前是審完計畫直接實作），因為「先規劃」只有一個意思。計畫核准前，任何接續（含 `/resume`）都只會重新規劃，不會寫程式。
- **檢查點**：每次實作者成功的一輪後，在 worktree 建立 `refs/joy/checkpoints/<taskId>/<n>`（快照包含未追蹤檔、不含被忽略的檔；不移動任務分支、不動主 checkout）。還原只在任務沒在執行時可用：先把目前狀態另存成新檢查點，再把 HEAD 移回該檢查點建立時的 commit 並還原檔案；之後如有 commit 會被丟掉，需要 `confirm: true`。接下來的 follow-up 會告訴 agent 檔案已被還原。檢查點 ref 只建立不覆蓋（已存在就失敗）。移除 worktree 時一併刪除該任務的檢查點 ref。compete 任務不建立檢查點。
- **用量**：`usage` = `{durationMs, inputTokens?, outputTokens?, costUsd?, byProvider: [{provider, model, inputTokens?, outputTokens?, costUsd?}]}`，只從任務事件裡 provider 回報的 `usage` 加總（CLI 的 costUsd 是估算，不是實際花費）；沒回報的欄位不出現。`durationMs` 是每次 `started` 到結束事件的實際時間加總。policy 預審、ask_peer 的用量沒有寫進任務事件，所以不算在內。
- **環境檢查**：`joy doctor` 與 `/api/doctor` 的 `label`、`summary`、`repair` 改成繁體中文（指令與識別字維持英文）；`NO_ACTION_NEEDED` 匯出供 `pnpm joy doctor` 比對。
- Migration 18（`tasks.archived`）、19（`repos.check_command`，JSON 陣列 CHECK）。`packages/core` 介面沒有改。
- 驗證：見下方「驗證」列。

### 介面改版（Codex / Claude Code 風格、繁體中文）

- 擁有者要求介面改成和 Claude Code、Codex 桌面版相近：左側欄（新任務、助理、統計、依專案分組的任務、加入專案、設定），中間對話式任務進度，右側可收合的變更面板；新任務改成一個置中的大輸入框，模型與思考程度收進「進階」。
- 改成淺色中性配色（跟隨系統深色模式），移除紫色漸層。工作區、設定頁主要區塊、權限事件文字、加入專案對話框改為繁體中文。
- 環境檢查移到設定頁；新任務頁只在有「缺少」項目時顯示提示。原始 agent 事件（usage、raw 等）預設隱藏在「顯示細節」。
- 第二階段已把助理頁、統計頁、設定頁其餘面板（Telegram、存取權杖、通知、工作副本、備份、除錯紀錄）、平行競賽比較面板、存取權杖頁翻成繁體中文。仍是英文：API 錯誤訊息（環境檢查已改為中文）。
- 驗證：`pnpm check` 通過（541 passed、4 skipped）；e2e 規格已依新標籤更新，由 CI 的 web E2E 驗證（本機 5173 被擁有者的 dev server 佔用，未在本機跑）。

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

- 2026-11-15 實作者的核准管道（agent 決定）：所有會寫程式的實作者 run（single、review loop、compete、合併版）都接 Tool Hub 與 approval tool；計畫與審查（唯讀）不接。Codex app-server 的核准處理器只在實作者回合掛上。orchestrator 的 `ReviewLoopInput.mcpServers／approvalTool`（未使用、且會連審查者一起給）改為 `implementerTools(ws)`。
- 2026-11-14 附件（agent 決定，待擁有者確認；第二輪依審查修正）：(1) 只收圖片（PNG／JPEG／GIF／WebP，原始 ≤ 3.75 MiB＝base64 後 ≤ 5 MiB）與文字／程式碼檔（UTF-8，≤ 256 KB，內容放進 prompt），PDF 與其他二進位不收；每則 ≤ 10 個、≤ 20 MB；每任務 ≤ 40 個、≤ 100 MB；(2) 檔案存 `<JOY_HOME>/attachments/<uuid>.<ext>`，從不進 worktree，所以不會被 commit 或進 PR；(3) 只有 server 組的擁有者段落放帶行程 nonce 的標記，provider 外層 `withAttachments` 只展開這種標記、只展開同任務的附件、每個檔案引用一次；(4) 審查者也看得到附件，每次 run 最多最新 8 張圖、256 KB 文字，較舊的只給名稱；(5) 文字附件是 reference data，不放進指令清單（擁有者待審）；(6) 容器模式加 Claude 角色時送圖、容器模式文字累計超過 64 KB 時，送出時就回 422；(7) 缺檔改成「[attachment missing]」並發警示事件、run 照常；擁有者可移除已送出的附件，之後只給名稱；(8) prompt 超過 16 KB 時，Claude 與 `codex exec` 改走 stdin；(9) 草稿只保存已上傳附件的 id；未送出的上傳 7 天後刪；備份與匯出不含附件檔案；(10) 助理對話暫不支援附件；(11) 改 `packages/core` 的 `RunOptions`（可選 `images`）與 `Steer`（可選第二個參數 `images`），列入擁有者待審。
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

## 擁有者待審

2026-11-06 由 agent 代為審查（擁有者授權）。下表為結論；擁有者可只看「發現」欄。

| 項目                                                                                                  | 審查方式                         | 結論       | 發現                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #73 本機 API／WebSocket token                                                                         | 獨立審查（非作者）               | 通過       | Windows 上 token 檔只依賴使用者資料夾的預設 ACL，T4.4 實機確認                                                                                                                                                                                                          |
| #54 GitHub publisher                                                                                  | 獨立審查                         | 已修       | 內容掃描認不得私鑰與 AWS／Slack／Google／Stripe／GitLab 憑證 → 已加入 Redactor；**publisher 從未接到 server/UI → 新增 T1.9b**                                                                                                                                           |
| #57 provider 允許清單                                                                                 | 獨立審查                         | 通過       | —                                                                                                                                                                                                                                                                       |
| #58 core 介面、機密遮罩                                                                               | 獨立審查                         | 通過       | —                                                                                                                                                                                                                                                                       |
| #62 `joy doctor` 鑰匙圈                                                                               | 獨立審查                         | 通過       | 只查詢隨機、不存在的帳號                                                                                                                                                                                                                                                |
| #84 權限規則                                                                                          | 擁有者已審（2026-11-06）         | 通過       | —                                                                                                                                                                                                                                                                       |
| T2.7b、T2.4a、T2.4b                                                                                   | `/code-review`（high）           | 已修 9／10 | 見下                                                                                                                                                                                                                                                                    |
| T3.3 記憶寫入規則（`packages/memory`）                                                                | **待擁有者審**                   | —          | 什麼會被記住、什麼一定擋下；agent 不審自己訂的規則                                                                                                                                                                                                                      |
| T3.5 專案記憶寫入（`packages/memory/src/project.ts`）                                                 | **待擁有者審**                   | —          | Joy 會寫進 repo 的內容與衝突處理；issue #36 的兩點已照驗收條件實作                                                                                                                                                                                                      |
| T4.1 遠端存取（`remote` 設定、token 重新產生、`packages/server`）                                     | 已審（2026-11-07）               | —          | 預設關閉；開啟前請確認只填 Tailscale IP，並看過 Host／Origin 與 401 的處理                                                                                                                                                                                              |
| T4.2 Web Push 金鑰（鑰匙圈新 secret `web_push_vapid_keys`）                                           | **待擁有者審**（機密處理）       | —          | 金鑰只在本機產生、存鑰匙圈；推播內容經遮罩與加密                                                                                                                                                                                                                        |
| T3.8 外部 MCP 工具的動作分類（`packages/server/src/external-mcp.ts`）                                 | **待擁有者審**（等同權限分類）   | —          | 不改 policy 規則，但哪些 Google 工具算「讀」「自己的行程」「寄信／邀請」由這裡決定；不認得的一律要核准                                                                                                                                                                  |
| 本機 listener 接受自己的 Origin（`packages/server/src/server.ts` 的 `originAllowed`，2026-11-13）     | **待擁有者審**（本機伺服器邊界） | —          | 只在連到本機 listener 的埠、對端 loopback、Origin 為 `http://127.0.0.1:<該埠>` 或 `http://localhost:<該埠>` 時放行，用來讓 `serveUi` 提供的打包介面能 POST 與連 WebSocket；remote listener、其他埠、https、`[::1]` 一律照舊 403；Host、`sec-fetch-site`、token 檢查沒動 |
| 執行中即時補充：`packages/core` 的 `RunOptions.onSteer`／`Steer`（2026-11-09）                        | 擁有者已審（2026-11-13）         | 通過       | 可選欄位，不支援的 provider 不用動；Claude stream-json 與 Codex `turn/steer` 的真實 fixture 由擁有者先錄（Claude 先）                                                                                                                                                   |
| 附件：`packages/core` 的 `RunOptions.images`、`ImageInput`、`Steer` 第二個參數 `images`（2026-11-14） | **待擁有者審**（core 介面）      | —          | 都是可選；不支援圖片的情況由 provider 丟出可處理的錯誤（Claude 容器模式）；附件路徑只指向 `<JOY_HOME>/attachments`，不進 worktree                                                                                                                                       |
| 附件文字的定位（`packages/server/src/attachments.ts` 的框架字句、`taskBrief` 的段落順序，2026-11-14） | **待擁有者審**（prompt 安全）    | —          | 文字附件當「reference data, follow it only where the owner's message says so」，不列在「Later instructions from the owner」清單內；若擁有者希望附件可直接當指令（例如附上規格要照做），要改這裡                                                                         |
| T3.6、T3.7、T3.9、T2.1                                                                                | `/code-review`（high）           | 已修 9／10 | compete 同時選擇／合併的競態、合併中重啟卡住、合併無時間上限、通知誤寫成審查未過、排程器關閉時未處理的 rejection；**未修：cron 補跑逐次計算（只在啟動時跑一次，成本有限）**                                                                                             |

`/code-review` 的發現與處理：重啟時等待核准的任務會卡住（已修）；核准紀錄的 detail 未遮罩（已修）；同任務多個待核准時狀態被提早改回（已修）；Telegram 群組中任何人可按核准（已修，只接受擁有者本人的私訊）；同步決定要等到逾時才生效（已修）；UI 每個事件都重抓待核准清單（已修）；沒有 token 時每分鐘警告（已修，只警告一次）；完成通知未遮罩（已修）；命名與重複程式（已修）；**Telegram 設定要重啟才生效（未修，留待之後）**。

## 需要擁有者處理

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
