# Joy 目前狀態

> 進度以此文件與 `docs/PLAN.md` 為準。這次只更新兩份狀態文件；沒有改程式碼、其他 PR metadata、issue ticket code，或 PR #10。

- 最後更新：2026-11-04
- 文件基線：PR #25 head `4e0c143b58bcfea4b01af0adefcc572af9914f69`（`t3.5-project-memory`）。
- Live snapshot：2026-11-04 重新查核 GitHub issues/PRs、checks、reviews 與相關 Sessions；issue [#26](https://github.com/jimmynycuee/Joy/issues/26) 仍 open，本次只處理它要求的 docs status update。Issue [#13](https://github.com/jimmynycuee/Joy/issues/13) 也仍 open，但與本次無關且未修改。
- 整體：P2 尚有 owner/policy 決策；P3/P4 多項功能已交付部分 slice，但 acceptance 仍有缺口。Open PR 都仍 open；沒有證據可據此宣稱已部署。

## P0 / P1 狀態

- T1.3 `packages/providers/src/openai-api` 與 T1.10 `packages/secrets` 已存在於本次文件基線，`PLAN.md` 也已勾選完成；不要因近期兩個執行 Sessions 結束時保留各自未提交的工作副本而改標未完成。這兩個 Sessions 沒有 PR。
- T0.4：PR #3 的最新 live patch 記錄 2026-11-04 在已登入 macOS 環境使用 Codex CLI 錄到 edit、MCP、resume-1、resume-2 真實 fixtures，四次皆 exit code 0；edit 實際修正暫存 repo，MCP `-c` 注入及 `ask_peer` 有回應，resume 取回 `PELICAN`。這些是 CLI 原始事件，不代表 provider contract tests 或完整 ticket acceptance 已通過。原生 Windows、可用模型清單與 rate-limit 行為仍未驗證；`PLAN.md` 保持未勾選。此證據來自 PR #3 最新 patch；PR #25 基線中的 `docs/spikes/codex.md` 尚是較舊敘述，本次依範圍只更新 PLAN/STATUS。
- Codex adapter 的既有合成 fixtures 與真實錄製是不同證據；CI 或合成 fixtures 不等同 Windows 實機或 rate-limit 行為驗證。

## GitHub PR 快照

目前有 20 個 open PR：#2–#5、#8–#9、#11–#12、#14–#25（#13 是 issue，不是 PR）。每個 open PR 的目前 head 均回報 Ubuntu、macOS、Windows 三個 checks success；所有 open PR 都沒有 formal review。#3 與 #4 雖有成功的 check 結果，仍各自與 base branch conflict，不能視為已解決衝突或可合併。

非 draft open PR：

- [#2](https://github.com/jimmynycuee/Joy/pull/2)：base `main`，head `t0-foundation` @ `56895e8`。
- [#3](https://github.com/jimmynycuee/Joy/pull/3)：base `t0-foundation`，head `t1.1-claude-cli` @ `33b1b69`；與 base conflict。
- [#4](https://github.com/jimmynycuee/Joy/pull/4)：base `t1.1-claude-cli`，head `t1.4-worktree` @ `3e6cd92`；與 base conflict。
- [#5](https://github.com/jimmynycuee/Joy/pull/5)：base `t1.4-worktree`，head `t1.11-config` @ `d13197c`。

Draft open PR（以下各自目前三平台 checks success、沒有 formal review）：

- [#8](https://github.com/jimmynycuee/Joy/pull/8)：base `t1.7-event-log`，head `t1.9-github-pr` @ `38c6642`。
- [#9](https://github.com/jimmynycuee/Joy/pull/9)：base `t1.9-github-pr`，head `t1.8-web` @ `3660503`。
- [#11](https://github.com/jimmynycuee/Joy/pull/11)：base `t2.1-compete`，head `t2.2-tools` @ `d67fb2a`。
- [#12](https://github.com/jimmynycuee/Joy/pull/12)：base `t2.2-tools`，head `t3.9-model-stats` @ `45f18d2`。
- [#14](https://github.com/jimmynycuee/Joy/pull/14)：base `t2.2-tools`，head `t3.3-memory` @ `9d9f350`；memory-write rules 需要 owner review。
- [#15](https://github.com/jimmynycuee/Joy/pull/15)：base `t2.2-tools`，head `reason/t3-1-add-selectable-assi-7a20bfa9` @ `68f1354`。
- [#16](https://github.com/jimmynycuee/Joy/pull/16)：base `t2.1-compete`，head `t4.4-windows-codex` @ `a2cee58`；原生 CLI 探測與 WSL fallback 有實作，installer/distribution 尚缺，T4.4 保持 partial / unchecked。PR #16 自己的 PLAN patch 雖打勾，仍明列 installer 為 gap；本狀態依原 ticket acceptance 將 T4.4 保持未完成。
- [#17](https://github.com/jimmynycuee/Joy/pull/17)：base `t1.8-web`，head `t4.2-local-pwa` @ `f984271`；只有 installable PWA foundation，沒有 Web Push，T4.2 保持 partial / unchecked。
- [#18](https://github.com/jimmynycuee/Joy/pull/18)：base `t3.3-memory`，head `t3.6-event-memory` @ `d4df409`；只允許明確核准的摘要寫入，舊訊息缺來源 provenance，不自動摘要；embedding 延後。
- [#19](https://github.com/jimmynycuee/Joy/pull/19)：base `main`，head `t1.1-claude-cli` @ `33b1b69`；與 #3 同 head 的 open duplicate。保持原狀，不在本 issue 嘗試關閉。
- [#20](https://github.com/jimmynycuee/Joy/pull/20)：base `t1.8-web`，head `reason/t4-3-add-tauri-desktop-s-29500001` @ `1c511bd`。
- [#21](https://github.com/jimmynycuee/Joy/pull/21)：base `t1.8-web`，head `t4.1-remote-auth` @ `0945eae`。
- [#22](https://github.com/jimmynycuee/Joy/pull/22)：base `reason/t3-1-add-selectable-assi-7a20bfa9`，head `t3.2-dispatch-tools` @ `117557e`。
- [#23](https://github.com/jimmynycuee/Joy/pull/23)：base `t3.6-event-memory`，head `reason/t3-4-add-memory-manageme-5e3fdbbf` @ `e0686af`；管理 API 已交付，answer citations / per-answer references 尚無 production chat route 與 contract，T3.4 未完成。
- [#24](https://github.com/jimmynycuee/Joy/pull/24)：base `reason/t3-1-add-selectable-assi-7a20bfa9`，head `t3.8-google-workspace` @ `b88f0d1`。
- [#25](https://github.com/jimmynycuee/Joy/pull/25)：base `reason/t3-4-add-memory-manageme-5e3fdbbf`，head `t3.5-project-memory` @ `4e0c143`；project-memory proposal diff/review/apply API 已交付，production assistant/chat integration 仍缺，T3.5 未完成且 memory-write behavior 需 owner review。

合併狀態須和部署分開描述：

- [#1](https://github.com/jimmynycuee/Joy/pull/1) 已 merge 到 `main`。
- [#6](https://github.com/jimmynycuee/Joy/pull/6) 已 merge 到 feature base `t1.5-review-loop`；[#7](https://github.com/jimmynycuee/Joy/pull/7) 已 merge 到 feature base `t1.6-server`；[#10](https://github.com/jimmynycuee/Joy/pull/10) 已 merge 到 feature base `t1.8-web`。這三個 merge 都不表示已進 `main` 或已部署。
- 本次沒有核實任何 production deployment；不宣稱已部署或線上行為已驗證。

## 未完成與阻塞

- **T2.3 policy**：權限等級、動作分類與跨模型預審屬 owner 安全政策決策；在 owner 定義前不自行推定。
- **T2.4 Telegram**：依賴 T2.3 審核路徑，且須 owner 提供 bot credential、確認唯一允許的 chat identity；目前不宣稱已完成驗證。
- **T2.5 quota**：`codex exec --json` 的 rate-limit 結構化訊號與可靠偵測仍未證實；換 provider、排隊、價格／預算策略尚未定案，不以一般錯誤文字推測。
- **T2.6 Issue → task**：label / trigger 語義、允許的 repo/actor、預設 task mode 與可達 HTTPS webhook ingress / 簽章設定仍須明確決定與驗證。
- **T3.4**：PR #23 只完成記憶管理 slice；answer-level citations 與一鍵刪除仍等 production chat route 及 per-answer memory-reference contract。
- **T3.5**：PR #25 只完成 project-memory proposal diff/review/apply API；未有 production assistant/chat integration，且 memory write 行為仍需 owner review。
- **T3.7 scheduler**：對應 Session 目前仍 running，這一輪 queue-only 實作未完成、尚無 PR。不要將 queue-only 原型或進行中的 Session 說成 ticket 完成；時區/DST、missed-run、重疊/重試及排程程式任務的 approval 語義仍未定。
- **T4.2 PWA/Web Push**：PR #17 目前只有可安裝 PWA foundation，Web Push 未實作，整張 ticket 未完成。
- **T4.4 Windows**：PR #16 有 native Codex 探測與 WSL fallback 測試；ticket 仍包含 installer/distribution，該交付物尚不存在，保持未完成。
- **T4.5 Docker executor**：尚未交付；需 owner 決定 container identity / host 資源邊界、credential 是否及如何掛載、network policy，未經決策不實作或宣稱完成。
- 其他需 owner review 的安全敏感範圍包括 secrets、policy、channel identity 與 memory-write rules；open PR 無 formal review 的即時快照不等於審核通過。

## 目前 Sessions

- `Joy 全計畫總控續跑` 仍 running。
- `Joy T3.7 durable scheduler queue` 仍 running，無 PR URL；queue-only 實作未完成。
- T1.3 OpenAI API provider 與 T1.10 OS keychain Sessions 已結束，狀態摘要記錄其各自工作分支保留未提交變更且沒有 PR；這不改變文件基線中 provider / secrets packages 已存在、PLAN 已勾選的事實。
- 本次 status refresh Session 以乾淨文件基線 PR #25 head 工作，僅更新 `docs/PLAN.md` 和 `docs/STATUS.md`。
