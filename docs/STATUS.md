# Joy 目前狀態

> 進度以此文件與 `docs/PLAN.md` 為準。這次只更新兩份狀態文件；沒有改程式碼、其他 PR metadata、issue ticket code，或 PR #10。

- 最後更新：2026-11-04
- 文件基線：PR #25 head `4e0c143b58bcfea4b01af0adefcc572af9914f69`（`t3.5-project-memory`）。
- Live snapshot：2026-11-04 重新查核 GitHub PR #1–#12、#14–#32、issues #13/#26、checks、formal reviews 與相關 Sessions。Issue [#26](https://github.com/jimmynycuee/Joy/issues/26) 仍 open，是本次唯一文件更新目標；[#13](https://github.com/jimmynycuee/Joy/issues/13) 仍 open，已有 ready PR #30。
- 本快照共有 26 個 open PR：#2–#5、#8–#9、#11–#12、#14–#25、#27–#32（PR #13、#26 是 issues）。#29 是本次 docs-only draft，base `t3.5-project-memory`，已列入快照；#30/#31 為 ready、#32 維持 draft。
- 整體：P2 尚有 owner/policy 決策；P3/P4 多項功能已交付部分 slice，但 acceptance 仍有缺口。Open PR 與 merged-to-feature/main 分開記錄；沒有證據可據此宣稱已部署。

## P0 / P1 狀態

- T1.3 `packages/providers/src/openai-api` 與 T1.10 `packages/secrets` 已存在於文件基線，`PLAN.md` 的勾選是既有基線記錄；本次最新執行狀態不代表新交付：T1.3 Session 正在 `t1.3-openai-api` 驗證保留的 provider/test 修改，尚無 PR；T1.10 Session 已結束，`packages/secrets/` 僅為未追蹤、未發布工作，亦無 PR。只憑檔案存在或基線 checkbox 不宣稱這兩個 Sessions 已交付。
- T0.4：PR #3 的最新 live patch 記錄 2026-11-04 在已登入 macOS 環境使用 Codex CLI 錄到 edit、MCP、resume-1、resume-2 真實 fixtures，四次皆 exit code 0；edit 實際修正暫存 repo，MCP `-c` 注入及 `ask_peer` 有回應，resume 取回 `PELICAN`。這些是 CLI 原始事件，不代表 provider contract tests 或完整 ticket acceptance 已通過。原生 Windows、可用模型清單與 rate-limit 行為仍未驗證；`PLAN.md` 保持未勾選。此證據來自 PR #3 最新 patch；PR #25 基線中的 `docs/spikes/codex.md` 尚是較舊敘述，本次依範圍只更新 PLAN/STATUS。
- Codex adapter 的既有合成 fixtures 與真實錄製是不同證據；CI 或合成 fixtures 不等同 Windows 實機或 rate-limit 行為驗證。
- T1.2 Codex adapter 的真實 fixtures 尚未重跑 provider contract tests；該續作尚未開始，現無 T1.2 Session 或 PR。
- T1.5：PR #31 head `010d78a` 已 ready、未 merged，三平台 checks success。獨立 Claude Opus 5.5 read-only review 無 blocker；僅建議可選補 planner-reviewer invalid-verdict 測試，真實 Codex CLI read-only resume 仍未驗證。沒有 formal GitHub review。

## GitHub PR 快照

目前有 26 個 open PR：#2–#5、#8–#9、#11–#12、#14–#25、#27–#32（#13 與 #26 是 issues）。本次最新 live read 中，全部 26 個 PR 的 Ubuntu、macOS、Windows checks 均 success，PR #29 head `a99d5eb` 三平台 checks success。此快照在下一筆 corrective docs commit 前讀取；新 head 的 checks 需另行核實，不能沿用舊 head 的綠燈。所有 open PR 均無 formal GitHub review；獨立 Session 審查另行註明，不等同 formal review。#3 與 #4 仍各自與 base branch conflict，雖有 success checks，也不能視為衝突已解或可合併。

非 draft open PR：

- [#2](https://github.com/jimmynycuee/Joy/pull/2)：base `main`，head `t0-foundation` @ `56895e8`。
- [#3](https://github.com/jimmynycuee/Joy/pull/3)：base `t0-foundation`，head `t1.1-claude-cli` @ `33b1b69`；與 base conflict。
- [#4](https://github.com/jimmynycuee/Joy/pull/4)：base `t1.1-claude-cli`，head `t1.4-worktree` @ `3e6cd92`；與 base conflict。
- [#5](https://github.com/jimmynycuee/Joy/pull/5)：base `t1.4-worktree`，head `t1.11-config` @ `d13197c`。
- [#28](https://github.com/jimmynycuee/Joy/pull/28)：base `t1.6-server`，head `fix/t1.6-origin-host-validation` @ `af6bb19`；目前 ready（非 draft）、mergeable、尚未 merged，三平台 checks success。PR 限定於 local-only server 安全修補；獨立 read-only review 未發現阻塞，但 loopback Origin scheme/port 範圍、真實 Tauri 相容性與 T4.1 token/Host/Origin policy 仍是後續缺口。沒有 formal GitHub review。
- [#30](https://github.com/jimmynycuee/Joy/pull/30)：base `t1.5-review-loop`，head `fix/issue-13-git-identity-test` @ `da2f8c9`；ready、clean/mergeable、未 merged，三平台 checks success，沒有 formal review。對應 issue #13；PR body 記錄修前重現與修後 focused/full 本地 check。
- [#31](https://github.com/jimmynycuee/Joy/pull/31)：base `t1.5-review-loop`，head `fix/plan-first-resume-gate` @ `010d78a`；ready、未 merged，三平台 checks success，沒有 formal review。新增 resumed-planner-error regression test；獨立 Claude Opus 5.5 review 無 blocker，真實 Codex CLI read-only resume 仍未驗證。

Draft open PR（除各項特別註明外，三平台 checks success；均無 formal GitHub review）：

- [#8](https://github.com/jimmynycuee/Joy/pull/8)：base `t1.7-event-log`，head `t1.9-github-pr` @ `38c6642`。
- [#9](https://github.com/jimmynycuee/Joy/pull/9)：base `t1.9-github-pr`，head `t1.8-web` @ `3660503`。
- [#11](https://github.com/jimmynycuee/Joy/pull/11)：base `t2.1-compete`，head `t2.2-tools` @ `d67fb2a`。
- [#12](https://github.com/jimmynycuee/Joy/pull/12)：base `t2.2-tools`，head `t3.9-model-stats` @ `45f18d2`。
- [#14](https://github.com/jimmynycuee/Joy/pull/14)：base `t2.2-tools`，head `t3.3-memory` @ `9d9f350`；memory-write rules 需要 owner review；另有未解 credential-filtering review blocker（見下方 T3.3）。
- [#15](https://github.com/jimmynycuee/Joy/pull/15)：base `t2.2-tools`，head `reason/t3-1-add-selectable-assi-7a20bfa9` @ `68f1354`。
- [#16](https://github.com/jimmynycuee/Joy/pull/16)：base `t2.1-compete`，head `t4.4-windows-codex` @ `a2cee58`；原生 CLI 探測與 WSL fallback 有實作，installer/distribution 尚缺，T4.4 保持 partial / unchecked。PR #16 自己的 PLAN patch 雖打勾，仍明列 installer 為 gap；本狀態依原 ticket acceptance 將 T4.4 保持未完成。
- [#17](https://github.com/jimmynycuee/Joy/pull/17)：base `t1.8-web`，head `t4.2-local-pwa` @ `f984271`；只有 installable PWA foundation，沒有 Web Push，T4.2 保持 partial / unchecked。
- [#18](https://github.com/jimmynycuee/Joy/pull/18)：base `t3.3-memory`，head `t3.6-event-memory` @ `d4df409`；只允許明確核准的摘要寫入，舊訊息缺來源 provenance，不自動摘要；embedding 延後。
- [#19](https://github.com/jimmynycuee/Joy/pull/19)：base `main`，head `t1.1-claude-cli` @ `33b1b69`；與 #3 同 head 的 open duplicate。保持原狀，不在本 issue 嘗試關閉。
- [#20](https://github.com/jimmynycuee/Joy/pull/20)：base `t1.8-web`，draft head `reason/t4-3-add-tauri-desktop-s-29500001` @ `1c511bd`，三平台 checks success。獨立 Claude Opus 5.5 read-only review 要求修改：`review_ready` 每 3 秒重複提醒為 blocker，另有 single-instance、root build/signing dependency、dev workflow、lifecycle/updater 等 finding；這不是 formal GitHub review。T4.3 continuation Session 正在執行，但 live PR head 尚未包含後續修正。
- [#21](https://github.com/jimmynycuee/Joy/pull/21)：base `t1.8-web`，head `t4.1-remote-auth` @ `0945eae`。
- [#22](https://github.com/jimmynycuee/Joy/pull/22)：base `reason/t3-1-add-selectable-assi-7a20bfa9`，head `t3.2-dispatch-tools` @ `117557e`。
- [#23](https://github.com/jimmynycuee/Joy/pull/23)：base `t3.6-event-memory`，head `reason/t3-4-add-memory-manageme-5e3fdbbf` @ `e0686af`；管理 API 已交付，answer citations / per-answer references 尚無 production chat route 與 contract，T3.4 未完成。
- [#24](https://github.com/jimmynycuee/Joy/pull/24)：base `reason/t3-1-add-selectable-assi-7a20bfa9`，head `t3.8-google-workspace` @ `b88f0d1`。
- [#25](https://github.com/jimmynycuee/Joy/pull/25)：base `reason/t3-4-add-memory-manageme-5e3fdbbf`，head `t3.5-project-memory` @ `4e0c143`；project-memory proposal diff/review/apply API 已交付，production assistant/chat integration 仍缺，T3.5 未完成且 memory-write behavior 需 owner review。
- [#27](https://github.com/jimmynycuee/Joy/pull/27)：base `t3.2-dispatch-tools`，head `t3.7-scheduler` @ `9975659`；draft，三平台 checks success。持久化 schedule 可在 DB reopen 後讀取，due 時只呼叫注入的 queue-only callback，不啟動 agent 或外部副作用；T2.3 owner policy 仍阻塞完整 T3.7 acceptance。
- [#29](https://github.com/jimmynycuee/Joy/pull/29)：base `t3.5-project-memory`，open draft，僅改兩個文件檔案，沒有 formal review。最新 live read 顯示 head `a99d5eb` 三平台 checks success；本快照在下一筆 corrective docs commit 發布前讀取，新 head 的 checks 須另行驗證。
- [#32](https://github.com/jimmynycuee/Joy/pull/32)：base `t3.3-memory`，head `fix/github-pat-memory-filter` @ `a8f5d52`；draft、未 merged，三平台 checks success，memory focused tests 10 passed。新的 PAT pattern 移除前置 word boundary 並補上直接 regex、ingest、generic write tests；第二次獨立 Claude Opus 5.5 review 確認先前兩項 findings 已修正，無 blocker。PR body 記錄本地完整 `pnpm check` 有 1 個 inherited Git identity failure（197 passed、2 skipped、1 failed）；仍須 owner review / integration，沒有 formal GitHub review。

合併狀態須和部署分開描述：

- [#1](https://github.com/jimmynycuee/Joy/pull/1) 已 merge 到 `main`。
- [#6](https://github.com/jimmynycuee/Joy/pull/6) 已 merge 到 feature base `t1.5-review-loop`；[#7](https://github.com/jimmynycuee/Joy/pull/7) 已 merge 到 feature base `t1.6-server`；[#10](https://github.com/jimmynycuee/Joy/pull/10) 已 merge 到 feature base `t1.8-web`。這三個 merge 都不表示已進 `main` 或已部署。
- 本次沒有核實任何 production deployment；不宣稱已部署或線上行為已驗證。

## 未完成與阻塞

- **T2.3 policy**：權限等級、動作分類與跨模型預審屬 owner 安全政策決策；在 owner 定義前不自行推定。
- **T2.4 Telegram**：依賴 T2.3 審核路徑，且須 owner 提供 bot credential、確認唯一允許的 chat identity；目前不宣稱已完成驗證。
- **T2.5 quota**：`codex exec --json` 的 rate-limit 結構化訊號與可靠偵測仍未證實；換 provider、排隊、價格／預算策略尚未定案，不以一般錯誤文字推測。
- **T2.6 Issue → task**：label / trigger 語義、允許的 repo/actor、預設 task mode 與可達 HTTPS webhook ingress / 簽章設定仍須明確決定與驗證。
- **T3.3 credential filtering**：原 PR #14 head 缺少 `github_pat_…` PAT 過濾，佔位輸入曾使 `isSensitiveContent` 回傳 `false`。獨立 draft PR #32（base `t3.3-memory`，head `a8f5d52`）已補 pattern，並移除會漏掉 word-character adjacency 的前置 boundary；10 個 memory tests 與三平台 GitHub checks success。第二次獨立 Claude Opus 5.5 review 確認先前兩項 findings（joined-prefix false negative、測試未獨立覆蓋 regex）均已修正，無 blocker。修補仍只在未合併的 PR #32，尚未整合到 PR #14 / 其後續分支，且 memory-write rules 仍待 owner review；PR #14 未修改。#32 本地完整 `pnpm check` 有 1 個 inherited Git identity failure（197 passed、2 skipped、1 failed），故不能宣稱本地全套檢查全綠。
- **T3.4**：PR #23 只完成記憶管理 slice；answer-level citations 與一鍵刪除仍等 production chat route 及 per-answer memory-reference contract。
- **T3.5**：PR #25 只完成 project-memory proposal diff/review/apply API；未有 production assistant/chat integration，且 memory write 行為仍需 owner review。
- **T3.7 scheduler**：PR #27 已交付可持久化並可於重開 DB 後讀取的 queue-only slice；`runDue()` 只呼叫注入的 enqueue callback，不啟動 coding agent 或外部 side effect。T2.3 owner policy 對排程工作 lifecycle / approval 的決定仍缺；時區/DST、missed-run、跨 process overlap、retry/backoff 也未完成。Session 已結束，PR #27 維持 draft，T3.7 不勾 full completion。
- **T4.2 PWA/Web Push**：PR #17 目前只有可安裝 PWA foundation，Web Push 未實作，整張 ticket 未完成。
- **T4.4 Windows**：PR #16 有 native Codex 探測與 WSL fallback 測試；ticket 仍包含 installer/distribution，該交付物尚不存在，保持未完成。
- **T4.5 Docker executor**：尚未交付；需 owner 決定 container identity / host 資源邊界、credential 是否及如何掛載、network policy，未經決策不實作或宣稱完成。
- **T1.6 / T4.1 remote security**：PR #28 已是 ready、mergeable 的 local-only hardening，未實作 token-authorized remote access。獨立 read-only review 沒有發現阻塞；仍需精確限制 loopback Origin 的 scheme/port，且 T4.1 的 Host/Origin 驗證順序 owner question 仍待答覆，再據此完成 token 順序與 HTTP/WebSocket 測試。真實 Tauri preflight / Windows-origin 相容性尚未驗證。
- **T4.3 desktop**：PR #20 live head `1c511bd` 仍為 draft，三平台 checks success；獨立 review 指出 persistent `review_ready` 狀態會每 3 秒重複提醒，另有 single-instance、root build/signing dependency 與 lifecycle/updater/dev-workflow findings。T4.3 continuation Session 正在處理；不把舊 head 的綠燈或 review 結果寫成修正已交付。
- **PR #9 test-harness follow-up**：read-only patch review 確認 `apps/web/e2e/fake-preview.ts` 的 Vite `server.host` 設為 `0.0.0.0`，但 `apps/web/vite.config.ts` 綁 `127.0.0.1`。LAN exposure 僅在 fake-provider preview 執行時，屬測試 harness 安全 follow-up，不是 production bind；本次不修改 PR #9。
- 其他需 owner review 的安全敏感範圍包括 secrets、policy、channel identity 與 memory-write rules；open PR 無 formal review 的即時快照不等於審核通過。

## 目前 Sessions

- `Joy 全計畫總控續跑` 仍 running。
- `Joy T3.7 durable scheduler queue` 已 exit；交付 draft PR #27，queue-only slice 與 T2.3 policy blocker 如上。
- `Joy T1.6 server security remediation` 已 exit；PR #28 head `af6bb19` 的 focused server tests 9/9 與完整 `pnpm check`（155 passed、2 skipped）由該 Session 回報通過；最新 live GitHub 三平台 checks 也 success。兩個獨立 read-only security review Sessions 已 exit，無 blocker verdict，但保留上列低風險/後續相容性發現；這不是 formal GitHub review.
- `Joy T4.3 Tauri desktop app` continuation 仍 running；PR #20 live head `1c511bd` 的三平台 checks success，但獨立 Claude Opus 5.5 review Session 已 exit，要求修正 repeated `review_ready` alerts 及其他 findings。沒有 formal GitHub review，且未見修正進入 live PR head。
- `Joy issue #13 Git identity test isolation` 已 exit，交付 ready PR #30；三平台 checks success，沒有 formal GitHub review。
- `Joy T1.5 planFirst resume gate` 已 exit，交付 ready PR #31；三平台 checks success。其獨立 Claude Opus 5.5 read-only reviewer Session 已 exit，無 blocker，留有可選 planner/reviewer invalid-verdict 測試建議；真實 Codex read-only resume 仍未驗證，沒有 formal GitHub review。
- `Joy T3.3 GitHub token memory filter` 已 exit，交付 draft PR #32；三平台 checks success，本地完整 `pnpm check` 有一個 inherited Git identity failure（197 passed、2 skipped、1 failed）。第二次獨立 Claude Opus 5.5 reviewer Session 已 exit，確認先前兩個 findings 已修正、無 blocker；無 formal GitHub review。修補仍未合併/整合進 PR #14；memory-write owner review 尚待完成，PR #14 未修改。
- `Joy T1.3 OpenAI API provider` is running on `t1.3-openai-api`, validating its preserved modified provider/test files; it has no PR yet.
- `Joy T1.10 OS keychain secrets` 已 exit；`t1.10-keychain` 只有未追蹤的 `packages/secrets/` 工作，未 commit / 未發布，也沒有 PR。兩項 `PLAN.md` checkbox 是基線記錄，不作為本次 Session 已交付的證據。
- 本次 status refresh 對照 PR #25 head `4e0c143` 的文件基線，只更新 `docs/PLAN.md`、`docs/STATUS.md`，並沿用既有 draft PR #29；沒有改程式碼、其他 PR metadata、issue metadata 或 PR #10。
