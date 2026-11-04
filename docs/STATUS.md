# Joy 目前狀態

> 本次依 issue [#26](https://github.com/jimmynycuee/Joy/issues/26) 更新此文件與 `docs/PLAN.md`；僅文件變更，沒有改程式碼、既有 PR metadata、issue metadata 或 `.artifacts/`。

- 最後更新：2026-11-04
- 文件基線：live branch `t3.5-project-memory`，commit `43646cb5f9790098f8d3991ddf4c3b13c63c577a`；本次工作使用從此基線建立的獨立文件分支。
- Live snapshot：2026-11-04 重新查核 GitHub 所有目前 open PR 與相關已 merge PR 的 head/base/draft/checks/formal reviews，以及 issues #26、#34、#35、#36。取樣時有 25 個既有 open PR；新文件 PR 不包含在此數量內。Issues #26、#34、#35、#36 均 open。
- 所有 25 個既有 open PR 的 live GitHub Actions snapshot 均列出 Ubuntu、macOS、Windows 三平台 checks success；#3、#4 另有 merge conflict，不因舊 checks 綠燈而可合併。每個 open PR snapshot 都沒有 formal GitHub review；獨立 Session review 不等同 formal review。
- 整體：P2 尚有 owner/policy 決策；P3/P4 多項功能有部分交付但 acceptance 尚有缺口。Merged-to-feature、merged-to-main 與 deployed 分開記錄；本快照沒有 production deployment 證據。

## P0 / P1 狀態

- T0.4：PR #3 的已記錄證據是在已登入 macOS 環境使用 Codex CLI 錄到 edit、MCP、resume-1、resume-2 真實 fixtures，四次皆 exit code 0；edit 實際修正暫存 repo，MCP `-c` 注入及 `ask_peer` 有回應，resume 取回 `PELICAN`。這些 CLI 原始事件不代表 provider contract tests 或完整 ticket acceptance 已通過。原生 Windows、可用模型清單與 rate-limit 行為仍未驗證；`PLAN.md` 保持未勾選。真實錄製與合成 fixtures 是不同證據。
- T1.2 Codex adapter 的真實 fixtures 尚未重跑 provider contract tests；該續作仍未驗證。CI 或合成 fixture 不等同 Windows 實機或 rate-limit 行為驗證。
- T1.3：目前有 draft PR [#33](https://github.com/jimmynycuee/Joy/pull/33)，base `t1.1-claude-cli`，head `t1.3-openai-api-stack` @ `6e9efcf`；Ubuntu、macOS、Windows checks 全部 success。PR body 說明 usage-table persistence 尚未實作或驗證，因此 `PLAN.md` 保持未勾選；draft/CI 綠燈不代表完整 ticket acceptance。
- T1.5：PR [#31](https://github.com/jimmynycuee/Joy/pull/31) 已 merge 到 feature base `t1.5-review-loop`，head `010d78a`；三平台 checks success。它加入 planFirst resumed-planner-error regression test。既有獨立 read-only review 回報無 blocker，這不是 formal GitHub review；真實 Codex CLI read-only resume 仍未驗證。

## GitHub PR 快照

以下 head、base、draft 與 checks 依 live snapshot 記錄；所有列出的 open PR 都有 Ubuntu、macOS、Windows 三個 success checks。分組依 live draft 狀態，不代表可合併；正式 review 狀態與獨立 review 分開說明。

非 draft open PR：

- [#2](https://github.com/jimmynycuee/Joy/pull/2)：base `main`，head `t0-foundation` @ `56895e8`；涉及 `packages/core` provider interfaces，依 `AGENTS.md` 需 owner review。
- [#3](https://github.com/jimmynycuee/Joy/pull/3)：base `t0-foundation`，head `t1.1-claude-cli` @ `33b1b69`；與 base conflict，且 core interface changes 需 owner review。
- [#4](https://github.com/jimmynycuee/Joy/pull/4)：base `t1.1-claude-cli`，head `t1.4-worktree` @ `3e6cd92`；與 base conflict。
- [#5](https://github.com/jimmynycuee/Joy/pull/5)：base `t1.4-worktree`，head `t1.11-config` @ `d13197c`。
- [#28](https://github.com/jimmynycuee/Joy/pull/28)：base `t1.6-server`，head `fix/t1.6-origin-host-validation` @ `af6bb19`；ready、clean/mergeable、live snapshot 仍 open 且尚未 merged。此 PR 處理 Origin/Host 與 malformed-encoding findings；三平台 checks success，沒有 formal GitHub review。已有 squash merge 排程（parent run 結束後），但尚未由 live state 確認。它是 local-only hardening，不是 token-authorized remote access；loopback Origin scheme/port、真實 Tauri preflight 相容性與 T4.1 remote-auth policy 仍是分開的後續事項。

Draft open PR：

- [#8](https://github.com/jimmynycuee/Joy/pull/8)：base `t1.7-event-log`，head `t1.9-github-pr` @ `38c6642`。
- [#9](https://github.com/jimmynycuee/Joy/pull/9)：base `t1.9-github-pr`，head `t1.8-web` @ `3660503`。既有 read-only patch review 曾指出 fake-preview harness 與 Vite host 綁定位址不同；此為先前記錄的 follow-up，本次未重做該 review。
- [#11](https://github.com/jimmynycuee/Joy/pull/11)：base `t2.1-compete`，head `t2.2-tools` @ `d67fb2a`。
- [#12](https://github.com/jimmynycuee/Joy/pull/12)：base `t2.2-tools`，head `t3.9-model-stats` @ `45f18d2`。
- [#14](https://github.com/jimmynycuee/Joy/pull/14)：base `t2.2-tools`，head `t3.3-memory` @ `9d9f350`；memory-write rules 需 owner review；`github_pat_…` filtering 修補仍在獨立 PR #32，尚未整合到 #14。
- [#15](https://github.com/jimmynycuee/Joy/pull/15)：base `t2.2-tools`，head `reason/t3-1-add-selectable-assi-7a20bfa9` @ `68f1354`。
- [#16](https://github.com/jimmynycuee/Joy/pull/16)：base `t2.1-compete`，head `t4.4-windows-codex` @ `a2cee58`；已有原生 CLI 探測與 WSL fallback，installer/distribution 仍缺，T4.4 保持未完成。
- [#17](https://github.com/jimmynycuee/Joy/pull/17)：base `t1.8-web`，head `t4.2-local-pwa` @ `f984271`；只交付 installable PWA foundation，Web Push 未實作，T4.2 保持未完成。
- [#18](https://github.com/jimmynycuee/Joy/pull/18)：base `t3.3-memory`，head `t3.6-event-memory` @ `d4df409`；只允許明確核准的摘要寫入；舊訊息缺 provenance，不自動摘要，embedding 延後。
- [#19](https://github.com/jimmynycuee/Joy/pull/19)：base `main`，head `t1.1-claude-cli` @ `33b1b69`；與 #3 同 head 的 open duplicate。既有討論要求關閉；本次不更動其狀態。
- [#20](https://github.com/jimmynycuee/Joy/pull/20)：base `t1.8-web`，仍為 draft；current head `reason/t4-3-add-tauri-desktop-s-29500001` @ `1f1269c`；三平台 checks success。最新 PR 討論確認 issue [#35](https://github.com/jimmynycuee/Joy/issues/35) 的 P2 first-observation notification race 已在此 head 修正；未解的 P1 packaged app Joy API/server lifecycle 仍等待 owner 選定 runtime packaging path，因此 PR 保持 draft。Issue #35 implementation owner 為 AI 平台。既有 #20 review Session 持續處理；本次不重做 review。Live GitHub 沒有此 head 的 formal review。
- [#21](https://github.com/jimmynycuee/Joy/pull/21)：base `t1.8-web`，head `t4.1-remote-auth` @ `0945eae`。
- [#22](https://github.com/jimmynycuee/Joy/pull/22)：base `reason/t3-1-add-selectable-assi-7a20bfa9`，head `t3.2-dispatch-tools` @ `117557e`。
- [#23](https://github.com/jimmynycuee/Joy/pull/23)：base `t3.6-event-memory`，head `reason/t3-4-add-memory-manageme-5e3fdbbf` @ `e0686af`；management API 已交付，answer citations / per-answer references 尚待 production chat route 與 contract。
- [#24](https://github.com/jimmynycuee/Joy/pull/24)：base `reason/t3-1-add-selectable-assi-7a20bfa9`，head `t3.8-google-workspace` @ `b88f0d1`。
- [#25](https://github.com/jimmynycuee/Joy/pull/25)：base `reason/t3-4-add-memory-manageme-5e3fdbbf`，draft head `t3.5-project-memory` @ `43646cb`。Project-memory proposal diff/review/apply API 已交付，但 production assistant/chat integration 尚缺；依 PR body，memory-write behavior 必須 owner review。open issue [#36](https://github.com/jimmynycuee/Joy/issues/36) 記錄 caller-controlled approval boolean 與外部 editor race findings，implementation 等待 owner 明確批准 memory-write rule 變更。此任務沒有修改 PR #25，且沒有重做其既有 review Session。
- [#27](https://github.com/jimmynycuee/Joy/pull/27)：base `t3.2-dispatch-tools`，head `t3.7-scheduler` @ `9975659`；draft queue-only slice 可持久化並在 DB reopen 後讀取，due callback 只 enqueue；T2.3 owner policy 仍阻塞完整 T3.7 acceptance。
- [#32](https://github.com/jimmynycuee/Joy/pull/32)：base `t3.3-memory`，draft head `fix/github-pat-memory-filter` @ `a8f5d52`；PAT pattern 修補及 memory focused tests 已交付，GitHub 三平台 checks success。仍須 owner review / integration，保持 draft。PR body 記錄獨立 Claude Opus 5.5 review 無 blocker（非 formal review）；本地完整 `pnpm check` 有一個 inherited Git identity failure（197 passed、2 skipped、1 failed）。
- [#33](https://github.com/jimmynycuee/Joy/pull/33)：base `t1.1-claude-cli`，draft head `t1.3-openai-api-stack` @ `6e9efcf`；三平台 checks success。
- [#37](https://github.com/jimmynycuee/Joy/pull/37)：base `fix/t1.6-origin-host-validation`（PR #28 head），draft head `fix/issue-34-single-non-editor-guard` @ `7d34f3f`；三平台 checks success。這是 issue #34 的 implementation，仍依賴 PR #28 merge，並未合併。

PR #20、#25、#32 與 #37 都維持 draft 狀態。本次沒有修改、重開、轉 ready 或 merge 任何既有 PR；除上文所列已存在的獨立 review 記錄外，沒有把獨立 review 當成 formal GitHub review。

## 合併狀態與部署

- [#1](https://github.com/jimmynycuee/Joy/pull/1) 已 merge 到 `main`。
- [#6](https://github.com/jimmynycuee/Joy/pull/6) 已 merge 到 feature branch `t1.5-review-loop`；[#7](https://github.com/jimmynycuee/Joy/pull/7) 已 merge 到 `t1.6-server`；[#10](https://github.com/jimmynycuee/Joy/pull/10) 已 merge 到 `t1.8-web`，不是 `main`；[#29](https://github.com/jimmynycuee/Joy/pull/29) 已 merge 到 `t3.5-project-memory`；[#30](https://github.com/jimmynycuee/Joy/pull/30) 與 [#31](https://github.com/jimmynycuee/Joy/pull/31) 已 merge 到 `t1.5-review-loop`。這些 feature-branch merges 不等於 merged to `main`。
- PR #30 對應 issue #13；PR #31 處理 planFirst resume regression。#30/#31 merge 時的三平台 checks 均 success。PR #10 的 live `base_ref` 明確為 `t1.8-web`，head `t2.1-compete`，不是 `main`。
- 本次沒有核實任何 production deployment；不宣稱上述 feature merges 已部署，也不宣稱 production 行為已驗證。

## 未完成與阻塞

- **T2.3 policy**：權限等級、動作分類與跨模型預審屬 owner 安全政策決策；在 owner 定義前不自行推定。
- **T2.4 Telegram**：依賴 T2.3 審核路徑，且需 owner 提供 bot credential、確認唯一允許的 chat identity；目前不宣稱完成驗證。
- **T2.5 quota**：`codex exec --json` 的 rate-limit 結構化訊號與可靠偵測仍未證實；換 provider、排隊、價格／預算策略尚未定案。
- **T2.6 Issue → task**：label / trigger 語義、允許的 repo/actor、預設 task mode 與 HTTPS webhook ingress / 簽章設定仍須決定與驗證。
- **T1.6 PR #6 review follow-ups**：PR #28 負責 Origin/Host 與 malformed-encoding findings，ready 但 live 仍 open；squash merge 已排程但尚未由 live state 確認。PR #31 負責 planFirst resume finding，已 merge 到 `t1.5-review-loop`。剩餘 non-editing-provider false-done finding 由 open issue [#34](https://github.com/jimmynycuee/Joy/issues/34) 追蹤，implementation owner 為 **AI 平台**；draft PR [#37](https://github.com/jimmynycuee/Joy/pull/37) 已提交修補，base 為 PR #28 head，三平台 checks success，仍待 #28 先 merge。#37 在 single mode 對不支援 code editing 的 provider 提前回傳 422，並保留合法 no-op/read-only 語義；PR body 記錄 focused server tests 11 passed、環境變數隔離後完整 `pnpm check` 157 passed / 2 skipped。該 PR 以 fake provider 驗證，沒有 real-provider 或 production run。
- **T3.3 credential filtering**：PR #14 的 `github_pat_…` filtering gap 由 draft PR #32 修補，但尚未整合至 #14 或其後續分支；memory-write rules 仍待 owner review。#32 本地完整 `pnpm check` 有一個 inherited Git identity failure，故不宣稱本地全套檢查全綠。
- **T3.4**：PR #23 只完成記憶管理 slice；answer-level citations 與一鍵刪除仍待 production chat route 及 per-answer memory-reference contract。
- **T3.5**：PR #25 只完成 project-memory proposal diff/review/apply API；production assistant/chat integration 未完成，且 memory-write behavior 需 owner review。Issue #36 追蹤 forged caller approval 與外部 editor race，實作等待 owner 明確批准 memory-write rule 變更；PR #25 保持 draft。
- **T3.7 scheduler**：PR #27 已交付 queue-only slice；T2.3 owner policy 對 lifecycle / approval 的決定仍缺，時區/DST、missed-run、跨 process overlap、retry/backoff 也未完成；T3.7 不勾 full completion。
- **T4.2 PWA/Web Push**：PR #17 只有可安裝 PWA foundation，Web Push 未實作，整張 ticket 未完成。
- **T4.4 Windows**：PR #16 有 native Codex 探測與 WSL fallback；installer/distribution 尚缺，保持未完成。
- **T4.5 Docker executor**：尚未交付；需 owner 決定 container identity / host 資源邊界、credential 是否及如何掛載、network policy，未經決策不實作或宣稱完成。
- **T1.6 / T4.1 remote security**：PR #28 是 local-only hardening，未實作 token-authorized remote access。loopback Origin scheme/port、真實 Tauri preflight / Windows-origin 相容性與 T4.1 Host/Origin policy 是分開的後續驗證/決策。
- **T4.3 desktop**：PR #20 仍是 draft，current head `1f1269c` 的三平台 checks success。Issue #35 的 first-terminal-poll notification race 已由此 head 修正；P1 packaged API/server lifecycle 仍等待 owner 選定 runtime packaging path，是保留 draft 的 blocker。repeated `review_ready` 也已由既有 review 記錄為修正；本次不重複 review。沒有 formal GitHub review；原生 tray/autostart/notification、packaged runtime 與 signed update delivery 依 PR body 仍未完整驗證。
- **PR #9 test-harness follow-up**：先前 read-only patch review 記錄 fake-provider preview 與 Vite host bind 不一致；屬 harness follow-up，不是 production bind。本次不修改或重新 review PR #9。
- 其他需 owner review 的安全敏感範圍包括 core interfaces、secrets、policy、channel identity 與 memory-write rules；open PR 的綠色 checks 不等於 review approval。

## 本次文件範圍

本次文件更新只記錄 issue #26 要求的 live project status 與 PR #6 review finding 對應關係；沒有執行或複製 PR #25 / #20 的 review，沒有改既有 PR/issue 狀態，也沒有宣稱部署。
