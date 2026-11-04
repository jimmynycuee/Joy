# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04 15:45 UTC
- 目前階段：**P1 尚未完成；P2 暫停，不開始或擴大。** 本次快照的最新 `main` 為 `2c3fdb4ca7924cd52dea62321d037a83e01766ab`（PR #51 merge）。PR #47（Plan v0.2）、#48（前次 STATUS 更新）與 #51（基線更新）皆已合併；目前沒有 P1 功能程式碼 PR 合併進 `main`。
- 合併後基線：PR #51 的 PR head `c6969c37` 上 Ubuntu、macOS、Windows 檢查皆成功；這不等同於對目前 merge commit 的 CI 結果。前次記錄的 [CI run 41840639086](https://github.com/jimmynycuee/Joy/actions/runs/41840639086) 對應舊 SHA `c311fe6ff6bb535151c7775d5e4728696feee02d`，不是目前 `main` 的驗證結果。
- 計畫與決策：依 `docs/PLAN.md` v0.2。已定案 Codex 在 P2 以 `app-server` 取代 `exec --json`（T2.7）、每個 repo 的 provider 允許清單（T1.12）、`joy doctor`（T1.13），以及額度用完先交接給另一家、兩家都無額度才排隊、成本上限依 config `budget`。決策已確定不代表 tickets 已完成；T1.12、T1.13 仍未完成。P1 順序依 PLAN：T1.6 + T1.7 → T1.12 → T1.9 → T1.13 → T1.8。

## P1 與必要依賴 PR 快照（2026-11-04 15:45 UTC）

PR 狀態、head、base、review 與 checks 均以本次 live `pr_get` 快照為準。分支改動或衝突解決後，舊 head 的 checks 不代表新 head。

1. **P0 基礎鏈仍阻塞：** [#2](https://github.com/jimmynycuee/Joy/pull/2) open、非 draft、base `main`，仍與目前 `main` 衝突；目前沒有 owner review／approval，也沒有目前 head 的 checks。其後依賴鏈 [#3](https://github.com/jimmynycuee/Joy/pull/3) → [#4](https://github.com/jimmynycuee/Joy/pull/4) → [#5](https://github.com/jimmynycuee/Joy/pull/5) 都 open；#3 與 `t0-foundation` 衝突、#4 與 `t1.1-claude-cli` 衝突、#5 對 `t1.4-worktree` 無衝突。三者目前顯示的 checks 皆成功且沒有 review；解衝突或更新 head 後仍須重驗。
2. **T1.6／T1.7 尚未進 `main`：** [#6](https://github.com/jimmynycuee/Joy/pull/6) 已併入依賴分支 `t1.6-server`；[#7](https://github.com/jimmynycuee/Joy/pull/7) 已併入依賴分支 `t1.7-event-log`。兩者都不是合併到 `main`。
3. **T1.6 修補分支重複且衝突：** [#28](https://github.com/jimmynycuee/Joy/pull/28) 與 [#46](https://github.com/jimmynycuee/Joy/pull/46) 皆 open、非 draft，共用分支 `fix/t1.6-origin-host-validation` 與 head `0cd9f58a4f36649121d7872fbd1cbd782fe5f820`；#28 base `t1.6-server`、#46 base `main`，兩者都與各自 base 衝突。兩者目前列出的 checks 皆成功，但仍受衝突阻擋。**#46 仍 open 時，不要發布 #28。** 須整理為單一適當 PR，解衝突後以新 head 重新驗證。
4. **T1.12：** [#53](https://github.com/jimmynycuee/Joy/pull/53) open/draft，base `t1.7-event-log`、head `ab669338a191a1931702cecb8ac6b1f1248920cd`，目前 clean，Ubuntu、macOS、Windows checks 成功。但獨立唯讀審查回報：resume 路徑可繞過 provider allowlist、provider 清單允許空值／重複值、錯誤指引不準確；原 PR Session 已被要求在同一 PR 修正並補回歸測試，修正尚未發布，且仍需 owner review。live PR 目前沒有 GitHub review/comment；舊 head 綠燈不涵蓋這些修正。
5. **T1.9：** [#8](https://github.com/jimmynycuee/Joy/pull/8) open/draft，base `t1.7-event-log`、head `604c3b2a9406db98f65719c11aa79d10e3b5e498`。Windows 非互動 `gh` timeout 修正已在此 head；Ubuntu 與 Windows 通過，macOS rerun attempt 2 仍 queued（run `41856606472`，與 #8/#54 關聯）。[PR #54](https://github.com/jimmynycuee/Joy/pull/54) 是同一 head 對 `main` 的另一個 open、非 draft PR，且與 `main` 衝突；#8 本身目前不衝突。兩者均無 review。
6. **T1.8：** [#9](https://github.com/jimmynycuee/Joy/pull/9) open/draft，base `t1.9-github-pr`、head `27c3de79514fe16e187f77ca9d04ddd7ec817e5c`；Ubuntu、Windows、macOS 與 web E2E 四項 checks 全綠，但 #9 與 base 衝突，且沒有 owner review。[#50](https://github.com/jimmynycuee/Joy/pull/50) 仍 open、非 draft，與 #9 共用 branch/head，但對 `main` 衝突；目前沒有 owner review。總控記錄的 P1-only 本機修正尚未發布；發布會同時更新 #50，故依目前限制暫停，等待使用者明確決定，不得推送或藉 #9 繞過此限制。
7. **其他 owner gate：** [#44](https://github.com/jimmynycuee/Joy/pull/44)（memory FTS row keys）仍 open、非 draft、base `t0-foundation`，目前無衝突且三平台 checks 成功；沒有 owner review，review gate 仍待處理。
8. [#21](https://github.com/jimmynycuee/Joy/pull/21) 的較後階段 E2E 失敗不屬於目前 P1 工作範圍；本次不調查也不修復。

## 擁有者待處理

- 審核 [PR #2](https://github.com/jimmynycuee/Joy/pull/2) 的 `packages/core` 介面變更；目前沒有 owner approval，且與 `main` 衝突。不得繞過此 gate。
- 審核 [PR #53](https://github.com/jimmynycuee/Joy/pull/53) 的 allowlist 修正；先由原 PR Session 完成三項修正及回歸測試，再進行 owner review。
- 審核 [PR #44](https://github.com/jimmynycuee/Joy/pull/44) 的 memory FTS／敏感記憶處理變更。
- [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 尚無 owner review；涉及 keychain／機密處理的內容仍須 owner 審核，維持 draft。#9/#50 共用分支的發布選擇仍待使用者明確決定。
- T0.4 仍依 `docs/PLAN.md` 保持未勾選；Codex 真實執行 fixture 尚缺，需在已登入的電腦上錄製。Windows 原生行為、rate-limit 輸出與實際可用模型名稱也尚不可視為完成驗收；確認預設模型名稱前不要猜測或改寫 PLAN §3.3。

## 下一步（依 `docs/PLAN.md` 依賴順序）

1. 先解除 P0 基礎鏈阻塞：取得 #2 owner review／approval 並解決其與最新 `main` 的衝突；再依 #2 → #3 → #4 → #5 整理依賴分支與衝突，完成核心介面所需 owner review，並在更新後的 heads 重跑 checks。
2. 將 T1.6 + T1.7 依序整合進 `main`（#6、#7 目前只合進依賴分支）。整理 #28/#46 為單一修補 PR；#46 尚 open 時不得發布 #28，解衝突後須以新 head 重跑檢查。
3. 完成 T1.12（#53）：原 PR Session 先修正 resume allowlist bypass、空／重複 provider 清單與錯誤指引，補回歸測試；再取得 owner review、更新 head checks，依序整合。
4. 推進 T1.9（#8）：確認 macOS attempt 2 結果，處理 #8/#54 相同 head 的 PR／base 衝突與整合目標；以合適新 head 重驗後依序整合。Windows timeout 修正目前在 #8 head 上已通過 CI。
5. 完成 T1.13 `joy doctor`。
6. 最後推進 T1.8（#9）：先等待使用者決定 #9/#50 共用分支如何處理；未獲明確選擇前不得發布會更新 #50 的 P1-only 本機修正。選定後解決衝突、更新並重驗 head，取得涉及 keychain／機密處理的 owner review。
7. 平行處理但不繞過 review gate：取得 #44 owner review。#21 的較後階段 E2E 失敗仍維持 out of scope。
8. 所有 P1 工作合併後，再驗證最新 `main` 的 `pnpm check` 與三平台 CI；**在此之前 P1 不得標示完成，也不開始或擴大 P2。**
