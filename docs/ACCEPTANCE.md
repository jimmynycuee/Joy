# 擁有者驗收清單

只有擁有者能做的驗收：要在已登入的電腦、真實帳號或另一台裝置上跑。依花的時間與需要的東西排序，由上往下做。
做完一項就打勾，並在「結果」寫一句（通過／哪裡不對）；agent 下次開工會讀到。

會呼叫真實模型的一律用最便宜的：Claude `haiku`、Codex `gpt-6-luna`、`effort: low`。不要在對話、文件或程式碼裡貼任何
token、PAT 或密碼。

## A. 這台 Mac、10 分鐘內

先更新 Joy：`git pull`、`pnpm joy build-ui`、`pnpm joy service install`（重新啟動服務，用上新的網頁）。

測試 repo：`/Users/jimmy/Documents/joy-acceptance-test`（2026-11-25 建，已加進 Joy；只有 `math.js` 與 README，沒有 GitHub remote）。

- [ ] **環境檢查（T1.13／T1.8）**：`pnpm joy doctor`，再看首頁的環境檢查；兩邊都列出這台 Mac 的 Claude、Codex、鑰匙圈與資料
      目錄，沒有讀出或顯示任何憑證。結果：2026-11-25 `pnpm joy doctor` 7 項都 OK、沒有顯示憑證；**首頁那一半還沒看**。
- [ ] **背景工作用 Claude 時的記憶與摘要（#173）**：把背景角色設成 Claude CLI `haiku`（low），跟助理聊幾句：對話摘要與記憶仍正常，
      記憶在安靜約 60 秒後才出現。結果：
- [ ] **第 2 輪只審改過的部分（#175）**：在測試 repo 開一個任務，故意留一個問題讓審查者退回，第 2 輪的審查卡應提到上一輪的意見。
      結果：

## B. 這台 Mac、15–30 分鐘

- [ ] **開 draft PR（T1.9）**：用這台 Mac 既有的 `gh` 登入。對測試 repo 跑完一個小任務，按變更面板上方的「Open draft PR」
      （第一次會要 GitHub repository URL）。確認遠端有測試分支、draft PR 標題以 `[test] ` 開頭、內容有審查摘要；驗收後關掉
      PR、刪掉分支。結果：
- [ ] **GitHub issue 變任務（T2.6）**：在測試 repo 開一個 issue 加上 `joy` label，5 分鐘內 Joy 出現 `#編號 標題` 的任務，
      標示外部內容、權限是「要求核准」。驗收後關閉 issue。結果：
- [ ] **container 模式（T4.5）**：Docker Desktop 開 host networking；`pnpm joy container-build`、
      `pnpm joy container-login claude`；把一個測試 repo 設成 container，跑一個小任務。結果：
- [ ] **助理長對話摘要（2026-11-20）**：用 `gpt-6-luna`（low）聊一段會查很多任務的長對話，直到對話頁出現「以上已整理成摘要」；
      之後問起前面決定的事，Joy 仍接得上。結果：

## C. 需要另一台裝置或電腦

- [ ] **手機 PWA 與推播（T4.2）**：開啟遠端存取並用 `tailscale serve` 提供 HTTPS，手機加入主畫面、允許通知，任務完成時收到推播。
      結果：
- [ ] **新電腦照 README 安裝（T4.9）**：新電腦或新的使用者帳號，從 clone 到跑完第一個任務，記下花多久、卡在哪。結果：
- [ ] **Windows 實機（T4.4）**：`pnpm install --frozen-lockfile`、`pnpm check`，再跑一次跨模型任務。結果：

## D. 擁有者決定暫緩（要做時再移到上面）

- T2.4 Telegram：要先在 @BotFather 建 bot。
- T3.8 Google 行事曆與 Gmail：要先建 Google Cloud OAuth 用戶端並登入一次（README「Google 行事曆與 Gmail」）。
- T4.3 Tauri 桌面版、P5 其餘：見 `docs/PLAN.md`。

## 待你審的程式碼

`packages/core` 與 `packages/policy` 已在 2026-11-19 確認；記憶擷取 prompt（#173）與 `pnpm joy open` 權杖交接（#181）已在
2026-11-25 確認。還沒審的：

- [ ] `packages/secrets` 的 MCP 機密（2026-11-17 外掛：設定 → 外掛新增的 MCP server，機密只存在鑰匙圈）。
- [ ] channel 認證（Telegram 只認擁有者的 chat id）。T2.4 暫緩，可以等要用時再審。
- [ ] 助理上下文摘要的兩個預設（2026-11-20）：「這段對話開的任務都沒有在排隊、執行或等核准」才整理（`review_ready` 算告一
      段落），以及 6 萬 token 下限、保留最近 10 則。
- [ ] 要不要在 Claude Code 開它自己的 Bash sandbox（2026-11-15 權限模式留下的問題；要先做 spike）。

## 已確認、從清單移除

| 項目                                         | 什麼時候、怎麼確認的                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm joy open`（#181）                      | 2026-11-25 擁有者執行成功；`~/.joy` 沒有留下 `open-*.html`                                                                                                   |
| 小改動輕量審查、用量分布（#176、#177、#185） | 2026-11-25 測試 repo 的 review loop（haiku／`gpt-6-luna` medium，改一行）：審查階段用 `low`、一輪通過；統計的用量分布有實作（Claude）與審查（Codex）兩列     |
| Claude CLI 當助理大腦（#183）                | 2026-11-25 暫時把大腦設成 Claude `haiku`：問「現在有哪些任務？」列出真的任務（叫得到 Joy 的工具）；那一輪 input 約 13.4k（含一次工具呼叫），之後設定改回預設 |
| T0.4 Codex 真實 fixture                      | 2026-11-19 錄製，contract test 通過；目前測過 0.166.0，與這台 Mac 裝的一致                                                                                   |
| T4.6／Claude 真實 fixture                    | 2026-11-19 用 2.1.319 重錄，contract test 通過；與這台 Mac 裝的一致                                                                                          |
| 不用終端機（背景服務）                       | 2026-11-25 `pnpm joy service status`：launchd 已載入、running，`http://127.0.0.1:4317` 有回應                                                                |
| 一律允許、auto 權限、附件                    | 2026-11-19 真實 CLI 第三、四輪通過（`docs/status-history.md`）                                                                                               |
| review loop、steer、compete                  | 2026-11-19 真實 CLI 冒煙測試與第二輪通過                                                                                                                     |
| 記憶擷取 prompt（#173）                      | 2026-11-25 擁有者確認                                                                                                                                        |
| `pnpm joy open` 權杖交接（#181）             | 2026-11-25 擁有者確認                                                                                                                                        |
