# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04 15:15 UTC
- 目前階段：**P1 整合進 `main`；P1 尚未完成。** 最新 `main` 為 `2c3fdb4ca7924cd52dea62321d037a83e01766ab`（PR #51 merge）。PR #47（Plan v0.2）、#48（前次 STATUS 更新）與 #51（本次基線更新）皆已合併；目前沒有 P1 功能程式碼 PR 合併進 `main`。
- 合併後基線：PR #51 的 PR head `c6969c37` 上 Ubuntu、macOS、Windows 檢查皆成功；這不等同於對目前 merge commit 的 CI 結果。前次記錄的 [CI run 41840639086](https://github.com/jimmynycuee/Joy/actions/runs/41840639086) 對應舊 SHA `c311fe6ff6bb535151c7775d5e4728696feee02d`，不是目前 `main` 的驗證結果。
- 計畫與決策：依 `docs/PLAN.md` v0.2。已定案 Codex 在 P2 以 `app-server` 取代 `exec --json`（T2.7）、每個 repo 的 provider 允許清單（T1.12）、`joy doctor`（T1.13），以及額度用完先交接給另一家、兩家都無額度才排隊、成本上限依 config `budget`。決策已確定不代表 tickets 已完成；T1.12、T1.13 仍未完成。P1 順序依 PLAN：T1.6 + T1.7 → T1.12 → T1.9 → T1.13 → T1.8。

## P1 與必要依賴 PR 快照（2026-11-04 15:15 UTC）

PR 狀態、head、base、review 與 checks 均以本次 live `pr_get` 快照為準。分支改動或衝突解決後，舊 head 的 checks 不代表新 head。

1. **P0 基礎鏈仍阻塞：** [#2](https://github.com/jimmynycuee/Joy/pull/2) 為 open、非 draft、base `main`；目前與最新 `main` 衝突，沒有 owner review／approval，也沒有可代表目前 head 的 checks。討論中紀錄的舊 checks 不可當作目前驗證。其後依賴鏈 [#3](https://github.com/jimmynycuee/Joy/pull/3) → [#4](https://github.com/jimmynycuee/Joy/pull/4) → [#5](https://github.com/jimmynycuee/Joy/pull/5) 均仍 open；#3、#4 與各自 base 衝突，#5 目前無衝突。三者目前列出的三平台成功結果只適用於已檢查的舊 head；核心介面變更仍須 owner review。
2. **T1.6／T1.7 尚未進 `main`：** [#6](https://github.com/jimmynycuee/Joy/pull/6) 已併入依賴分支 `t1.6-server`；[#7](https://github.com/jimmynycuee/Joy/pull/7) 已併入依賴分支 `t1.7-event-log`。兩者都不是合併到 `main`。
3. **T1.6 修補分支重複且衝突：** [#28](https://github.com/jimmynycuee/Joy/pull/28) 與 [#46](https://github.com/jimmynycuee/Joy/pull/46) 皆 open、非 draft，共用分支 `fix/t1.6-origin-host-validation` 與 head `0cd9f58a4f36649121d7872fbd1cbd782fe5f820`；#28 base `t1.6-server`、#46 base `main`，兩者都與各自 base 衝突。**#46 仍 open 時，不要發布 #28。** 須整理為單一適當 PR，解衝突後以新 head 重新驗證。
4. **T1.9：** [#8](https://github.com/jimmynycuee/Joy/pull/8) open/draft，base `t1.7-event-log`。Ubuntu 成功；Windows 在 `GitHubPublisher › times out a noninteractive gh process` 失敗：測試預期 `GitHub CLI PR lookup timed out after 40 ms`，實際先收到 `Git fetch of the configured base branch timed out after 40 ms`；macOS 仍 queued。此結果來自 [Windows check run 41853647972](https://github.com/jimmynycuee/Joy/actions/runs/41853647972)。
5. **T1.8：** [#9](https://github.com/jimmynycuee/Joy/pull/9) open/draft，base `t1.9-github-pr`，head `27c3de79514fe16e187f77ca9d04ddd7ec817e5c`。Ubuntu、Windows 與 web E2E 成功；先前 macOS run 取消後的 rerun 仍 queued；目前沒有 owner review。
6. **其他 owner gate：** [#44](https://github.com/jimmynycuee/Joy/pull/44)（memory FTS row keys）仍 open、非 draft、base `t0-foundation`；三平台 checks 成功，但沒有 owner review，review gate 仍待處理。
7. [#21](https://github.com/jimmynycuee/Joy/pull/21) 的較後階段 E2E 失敗不屬於目前 P1 工作範圍；本次不調查也不修復。

## 擁有者待處理

- 審核 [PR #2](https://github.com/jimmynycuee/Joy/pull/2) 的 `packages/core` 介面變更；目前沒有 owner approval，且與 `main` 衝突。不得繞過此 gate。
- 審核 [PR #44](https://github.com/jimmynycuee/Joy/pull/44) 的 memory FTS／敏感記憶處理變更。
- [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 尚無 owner review；涉及 keychain／機密處理的內容仍須 owner 審核，維持 draft。
- T0.4 仍依 `docs/PLAN.md` 保持未勾選；Codex 真實執行 fixture 尚缺，需在已登入的電腦上錄製。Windows 原生行為、rate-limit 輸出與實際可用模型名稱也尚不可視為完成驗收；確認預設模型名稱前不要猜測或改寫 PLAN §3.3。

## 下一步（依 `docs/PLAN.md` 依賴順序）

1. 先解除 P0 基礎鏈阻塞：取得 #2 owner review／approval 並解決其與最新 `main` 的衝突；再依 #2 → #3 → #4 → #5 整理依賴分支與衝突，完成核心介面所需 owner review，並在更新後的 heads 重跑 checks。
2. 將 T1.6 + T1.7 依序整合進 `main`（#6、#7 目前只合進依賴分支）。整理 #28/#46 為單一修補 PR；#46 尚 open 時不得發布 #28，解衝突後須以新 head 重跑檢查。
3. 完成 T1.12 repo provider allowlist。
4. 推進 T1.9（#8）：處理 Windows 非互動 `gh` timeout 測試失敗，等候 macOS queued 結果；更新後以新 head 驗證，再依賴順序整合。
5. 完成 T1.13 `joy doctor`。
6. 最後推進 T1.8（#9）：待前置項目就緒後更新／驗證 head、完成 macOS rerun，並取得 owner review。所有 P1 工作合併後，再驗證最新 `main` 的 `pnpm check` 與三平台 CI；**在此之前 P1 不得標示完成，也不開始或擴大 P2。**
7. 平行處理但不繞過 review gate：取得 #44 owner review。#21 的較後階段 E2E 失敗仍維持 out of scope。
