# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-05 04:06 UTC
- 目前階段：**P1 尚未完成；P2 依計畫順序暫停。** PR #58 的 P1 主體與 PR #60 的文件更新已合併。GitHub Actions 最新觀察到的 `main` push run（41962420463）對應 SHA `a0c76274e6adb092fd509ff41ba207a143a2a35c`，於 2026-11-05 03:35:57 UTC 完成且成功；這只證明該 run 的 SHA，不代表其他 PR head 已針對它驗證。
- 本次狀態快照取自 2026-11-05 04:06 UTC 的 live PR snapshots；本次只更新本檔，不改 `docs/PLAN.md` 的 ticket 勾選或其他檔案。
- 計畫狀態：依 `docs/PLAN.md` v0.2。T1.12、T1.13、T1.8、T1.9 與 T0.4 均未據本快照標記完成。

## P1 狀態與阻塞（GitHub 快照：2026-11-05 04:06 UTC）

1. **main 最新可見狀態：** Actions run `41962420463`（workflow `CI`，`main` push）於 `2026-11-05 03:35:57 UTC` 完成成功，head SHA 為 `a0c76274e6adb092fd509ff41ba207a143a2a35c`；Ubuntu、macOS、Windows 與 web E2E 四項 jobs 均成功。這是 workflow-run 證據，不是直接讀取 branch ref，也不替任何其他 SHA 背書。
2. **本文件所在 PR #65：** [#65](https://github.com/jimmynycuee/Joy/pull/65) 為 open/draft，base `main`，live head `54311a7a89776393b8136c7a274b22f1bb6b35cb`，base snapshot `a0c76274e6adb092fd509ff41ba207a143a2a35c`。GitHub 回報與目前 `main` 衝突，該 snapshot 沒有 checks。此分支既有 PR-wide comparison 有 20 個檔案；本次新增的變更仍限於 `docs/STATUS.md`，不整理或改動既有範圍。
3. **T1.8 / PR #9：** [#9](https://github.com/jimmynycuee/Joy/pull/9) 為 open/draft，base `t1.9-github-pr`、base snapshot `fbdb1a4e453653739d377426d003c77d021bf5f1`，head `5ce4e977c456de255686a496eddc3d1ce70c3b47`，live 狀態 clean、無衝突。該 head 的 `check (ubuntu-latest)`、`check (windows-latest)`、`check (macos-latest)`、`web E2E (ubuntu-latest)` 四項 checks 均 completed/success；正式 reviews 清單為空，owner reviewer `jimmynycuee` 已被請求。checks 僅代表此 head，不代表它已對齊最新 `main`。保持 draft，不更動 PR 或分支。
4. **T1.8 / PR #66：** [#66](https://github.com/jimmynycuee/Joy/pull/66) 為 open/draft，base `main`、base snapshot `a0c76274e6adb092fd509ff41ba207a143a2a35c`，與 #9 共用 head `5ce4e977c456de255686a496eddc3d1ce70c3b47`。GitHub 回報與目前 `main` 衝突；該 head 的上述四項 checks 均成功，但不驗證對齊或與最新 base 相容。本輪不修改 #66。
5. **T1.12 / PR #53：** [#53](https://github.com/jimmynycuee/Joy/pull/53) 為 open/draft，base `t1.7-event-log`、base snapshot `c196f74ade116c58f3b9dc00f27bbcc9ab84c525`，head `5ed6c322b81869edcd551268e10b1a6c6ecb2c0e`，live 狀態 clean。此 head 的 Ubuntu、Windows、macOS 與 web E2E 四項 checks 均 completed/success，formal reviews 清單為空；owner review 與 base alignment 仍待處理。checks 僅對應此 head，不能視為已對齊最新 `main`。維持 draft。
6. **PR #57 維持 open、未修改：** [#57](https://github.com/jimmynycuee/Joy/pull/57) 為 open、非 draft，與 #53 共用 head `5ed6c322b81869edcd551268e10b1a6c6ecb2c0e`，base `main`、base snapshot `2c3fdb4ca7924cd52dea62321d037a83e01766ab`。GitHub 回報它與目前 `main` 衝突；同一 head 的四項 checks 雖然成功，不能證明與最新 `main` 相容。本輪不改 #57 或其共享分支，維持 open。
7. **T1.13 / PR #62（canonical draft）：** [#62](https://github.com/jimmynycuee/Joy/pull/62) 為 open/draft，base `main`、base snapshot `ceebdc5c0117ed4b9bb2f25e126ed045651eb9d1`，live head `348593b25a601f5f88f2b07e959ec40be855e5d0`。GitHub 回報與目前 `main` 衝突；此 live head 沒有列出 checks，formal reviews 清單為空。獨立 review 的修正工作由其既有 Session 處理；本快照不宣稱修正已完成、已進入 PR，或已對新 head 驗證。保持 #62 為 canonical draft，不變更 PR metadata。
8. **PR #63：** [#63](https://github.com/jimmynycuee/Joy/pull/63) 為 closed、未合併；不是 T1.13 的 canonical PR。
9. **使用者 access gates：** T1.9 publisher 已整合至 `main`，但真實測試 repository/access 選擇仍未解除；fake `gh` 或 local bare remote 不替代真實驗收。T0.4 真實 Codex fixture 仍需使用者選定已登入的執行環境。未選定前不執行 gated actions，也不宣稱驗收完成；不假設 Cloud 已登入。
10. **P2 與其他 review：** T1.12/T1.13/T1.8 尚未完成相應驗收，T1.9/T0.4 gates 也未解除，故依 PLAN 保持 P2 暫停。其他 owner-review follow-ups 仍包括 [#44](https://github.com/jimmynycuee/Joy/pull/44)、`packages/core` provider/model interfaces 與 `packages/secrets` keychain handling；#21 不在本輪範圍。

## 下一步（依賴順序）

1. 先完成 T1.12 / #53 的 owner review 與 base alignment；更新後對確切的新 head 重新驗證。#57 維持 open、不修改。
2. 按 PLAN 接續 T1.9 真實測試 repository/access 選擇與驗收；取得選擇前不執行 gated test。T0.4 的已登入 Codex fixture 執行環境亦仍需使用者選定。
3. 接續 T1.13 / #62：由其既有 Session 完成獨立 review follow-up；待結果實際出現在 PR head 後，再對新 head 和最新 base 做相應驗證。此處不預先宣稱修正已完成。
4. 再按順序完成 T1.8 / #9 的整合驗收；checks 需對應實際更新後的 head/base。#66 維持不動。
5. 所有 P1 驗收與 T0.4/T1.9 gates 完成前，保持 P2 暫停；只有在最新 main/head 均經相應驗證後才依 PLAN 推進。

## 歷史 P1 狀態快照（PR 狀態截至 2026-11-04 18:49 UTC；main 更新至 18:52 UTC）

下列依賴 PR 的 head、checks 與 reviews 取自 18:49 UTC 的 live `pr_get` 快照；PR #55 隨後合併，使 `main` 前進至 `686b4f942962bc02dd5d615fa4d32421188b488c`。因此以下依賴 PR 狀態不是 #55 合併後重新讀取的 live 狀態；檢查結果只代表指定 head.

1. **主要 P1 堆疊已進 `main`：** [PR #58](https://github.com/jimmynycuee/Joy/pull/58) 已合併；其 head `8383dd80f5a5168d1db59728810e5bb91730e4da` 的 Ubuntu、macOS、Windows 與 web E2E 四項 checks 全通過（run `41887998301`）。整合內容涵蓋 T1.6/T1.7、T1.8、T1.9 及相關驗證修補；T2.1/compete 明確排除。PR #55 的 STATUS 更新亦已合併到最新 `main`；新 main 的 CI run `41891442701` 四項 jobs 全成功，先前 `59eb6b9` 的 run `41889004890` 亦四項全成功.
2. **T1.12 尚未合入：** [#53](https://github.com/jimmynycuee/Joy/pull/53) open/draft、base `t1.7-event-log`、head `3fd90219695c34bb38d37539158c765853208c21`、無衝突；Ubuntu、macOS、Windows checks 全成功，但沒有 owner review/approval。PR 說明列出 resume 前重新驗證 provider、allowlist 非空且唯一及錯誤指引等修正。18:49 UTC 快照亦記錄 [#57](https://github.com/jimmynycuee/Joy/pull/57) open、非 draft，與 #53 共用 head、base `main`，三平台 checks 成功且無正式 review；討論將其描述為重複 PR。須在合併後 `main` 上重新核對／驗證並取得 owner review，否則 T1.12 尚未完成.
3. **T1.13 尚未完成：** `joy doctor`／首次啟動檢查仍待實作與驗收；依序在 T1.12 後推進。
4. **已被 #58 整合的來源 PR：** #6、#7 本身只合入依賴分支，不是直接合入 `main`；其功能已隨 #58 進入 `main`。18:49 UTC 快照記錄 #8/#54 open 且共用 head `604c3b2a`；#8 為 draft、base `t1.7-event-log`，#54 為非 draft、base `main`，Ubuntu/Windows 成功、macOS cancelled。#8 的 T1.9 範圍已由 #58 整合。#9 仍 open/draft，head `27c3de79514fe16e187f77ca9d04ddd7ec817e5c`，四項 checks 成功但與 `t1.9-github-pr` 衝突，無 owner review；其 P1 UI 範圍由 #58 整合。此狀態更新不修改 #8/#9/#54 或其共用分支.
5. **基礎與重複修補 PR：** 18:49 UTC 快照記錄 #2 open、非 draft，base `main`、head `8de3b7abf944a474e1881af1c3a8c7de5ea67dab`；當時與 `main` 衝突，沒有 owner approval 或該 head 的 checks；基礎內容已透過 #58 整合，core 介面 owner review 仍是後續事項。#28/#46 當時皆 open、同 branch/head `fix/t1.6-origin-host-validation` / `0cd9f58a4f36649121d7872fbd1cbd782fe5f820`，分別與 `t1.6-server`／`main` 衝突；其 Origin/Host 修補已由 #58 整合。**#46 仍 open 時不要發布 #28。**
6. **其他 owner gate：** [#44](https://github.com/jimmynycuee/Joy/pull/44) 仍 open、非 draft、base `t0-foundation`、clean；Ubuntu、macOS、Windows checks 成功，但沒有 owner review。memory FTS／敏感記憶處理的 owner review 仍待完成。
7. [#21](https://github.com/jimmynycuee/Joy/pull/21) 的較後階段 E2E 失敗仍屬 out of scope；不調查、不修復。

## 歷史下一步（P1 依賴順序；截至 18:49 UTC）

1. 將 #53 T1.12 對齊目前 `main`，取得必要 owner review，對新 head 重跑 checks 後再整合。
2. 完成 T1.13 `joy doctor`／首次啟動檢查，依其驗收條件測試並整合。
3. T1.12 與 T1.13 完成後，在最新 `main` 重跑 `pnpm check` 與三平台 CI；只有全數通過才可標示 P1 完成並解除 P2 hold。#44、core interface 與 keychain/secret handling 的 owner review 仍須追蹤；#21 維持 out of scope。

## 歷史整合 PR #58（2026-11-04 18:30 UTC；合併前快照）

- [PR #58 — Integrate the P1 stack into main](https://github.com/jimmynycuee/Joy/pull/58)：draft、base `main` (`2c3fdb4`)、head branch `integrate-p1`；head `398d8f14472df8644e3d3ae56938f93d2a420efc`。最新讀取時 Ubuntu、macOS、web E2E 成功，Windows 仍執行中；獨立 review 尚待完成。
- 整合範圍包括 T1.6/T1.7、T1.8、T1.9、Origin/Host 驗證、provider capability/model-effort guard、keychain 不可用時 UI 可啟動、snapshot/cursor replay 與事件去重、implementer/fixer 不提供 `openai-api`，以及 web build/Playwright CI。Vite proxy 保留瀏覽器 Origin/Host 並關閉廣泛 CORS，`review_loop` 亦拒絕不具 code-edit 能力的 implementer。T2.1/compete 實作不在 #58；T0.4 Codex fixture、Windows 真機、登入、MCP 選擇與產品／成本選擇仍是外部或使用者項目，保留於下方追蹤。
- 本機驗證在本機 commit `2382074a11b21a2524a0a81e83e6ef293da39061`、tree `f2cb48c6fd0953608fbd39499d229536d267e6bf` 通過；已確認發布 head `398d8f14472df8644e3d3ae56938f93d2a420efc` 有完全相同的 tree。`pnpm install --frozen-lockfile` 成功；`env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=0 pnpm check` 成功（196 tests passed、2 skipped）；`pnpm --filter @joy/web build` 成功；`pnpm test:e2e` 成功（4 個 Playwright 測試，含 HTTP/WebSocket proxy Origin regression）。E2E 使用 fake provider，沒有真實模型/API 呼叫或支出。
- **Owner review（合併後 follow-up）**：`packages/core` provider/model interface 與 `packages/secrets` keychain/secret handling 均列入 owner review。依使用者明確授權，owner review 可在 #58 合併後持續追蹤，不是額外的合併 gate；仍須遵守 GitHub 實際 required approvals/checks。
- **阻塞**：config-save guard 已推送至 #58，新增 regression 已在未修正的 `4114d9b` 重現回應 200，修正後確認回應 422、沒有 provider call 且舊設定不變。新 head `398d8f1` 的 CI 最新讀取為 Ubuntu/macOS/web E2E 成功、Windows 執行中；仍需 Windows 通過及對此 head 的獨立無 blocker review。#58 維持 draft；T1.12 與 T1.13 是 #58 後的 P1 工作，不是 #58 合併 gate，完成後才開始 P2。#57 保持 owner action（`close:false`）；來源 PR 未關閉。此 Session 的 draft-only PR policy 不允許標 ready 或 merge。
- **下一步**：等待 #58 的 Windows CI 及對 head `398d8f1` 的獨立 review；若兩者通過，交由有權限者按 merge-commit 要求處理 ready/merge。之後按使用者順序完成 T1.12、T1.13，再解除 P2 hold；保持 #57 為 owner action（`close:false`），且不要把 owner review follow-up 變成合併 gate。

## PR 鏈快照（2026-11-04 14:20 UTC；歷史狀態）

以下僅保留 14:20 UTC 的歷史 PR/CI 快照；其狀態與 checks 不代表目前 `main` 或任何 PR 的即時狀態。解衝突、rebase 或推送後，舊 head 的 CI 不代表新 head。

1. [PR #2 — P0 foundation](https://github.com/jimmynycuee/Joy/pull/2)：open、非 draft，base `main`，head `56895e83`，與 base 衝突（dirty）。該 head 的 Ubuntu、macOS、Windows CI 成功；沒有 review，討論中要求 owner review。包含 `packages/core` 介面，owner review gate 未解除；不可繞過或合併。
2. [PR #3 — Claude Code provider](https://github.com/jimmynycuee/Joy/pull/3)：open、非 draft，base `t0-foundation`，head `33b1b69c`，有衝突；該 head 三平台 CI 成功。變更 `packages/core` provider interface，沒有 review，需 owner review。
3. [PR #4 — Git worktree executor](https://github.com/jimmynycuee/Joy/pull/4)：open、非 draft，base `t1.1-claude-cli`，head `3e6cd927`，有衝突；該 head 三平台 CI 成功。
4. [PR #5 — config](https://github.com/jimmynycuee/Joy/pull/5)：open、非 draft，base `t1.4-worktree`，head `d13197c0`，目前 clean；該 head 三平台 CI 成功。變更 `packages/core` 的 `ModelRef` provider 介面（加入 optional `effort`），需 owner review；目前沒有 review。
5. [PR #19](https://github.com/jimmynycuee/Joy/pull/19)：open draft，base `main`，head 與 #3 相同（`33b1b69c`），目前與 base 衝突；該 head 三平台 CI 成功。它是 #3 的重複 PR，不能用來繞過 #2 的 owner gate；在保留 #3 的依賴鏈後應關閉重複 PR。
6. [PR #6](https://github.com/jimmynycuee/Joy/pull/6)、[#7](https://github.com/jimmynycuee/Joy/pull/7) 與 [#31](https://github.com/jimmynycuee/Joy/pull/31)：均已合併到功能分支（#6/#31 合入 `t1.5-review-loop`，#7 合入 `t1.6-server`），尚未進 `main`。各自記錄的三平台 CI 成功，不代表其程式碼已整合至 `main`。
7. [PR #33](https://github.com/jimmynycuee/Joy/pull/33)：open draft，base `t1.1-claude-cli`，head `6e9efcf4`，目前 clean；該 head 三平台 CI 成功。需待基礎鏈重整後再 rebase、review 與驗證。
8. [PR #45](https://github.com/jimmynycuee/Joy/pull/45)：open draft，base `t1.11-config`，head `141e5e87`，目前 clean；該 head 三平台 CI 成功。依賴分支重整後仍須重驗。
9. [PR #28](https://github.com/jimmynycuee/Joy/pull/28) 與 [PR #46](https://github.com/jimmynycuee/Joy/pull/46)：同一分支、同一 head `0cd9f58a` 的 T1.6 Origin 驗證修補。#28 base `t1.6-server`、#46 base `main`，兩者目前都與 base 衝突；舊 head 三平台 CI 成功。應合成一份修補、更新 base、只保留一個 PR，並在新 head 重跑檢查。
10. [PR #37](https://github.com/jimmynycuee/Joy/pull/37)：open draft，base `fix/t1.6-origin-host-validation`，head `a4310d4a`，目前 clean；該 head 三平台 CI 成功。依賴 #28/#46 的修補分支，待其整理後更新 base 並重驗。
11. [PR #8](https://github.com/jimmynycuee/Joy/pull/8)：open draft，base `t1.7-event-log`，head `38c66421`，目前 clean；該 head 三平台 CI 成功。
12. [PR #9 — Web UI](https://github.com/jimmynycuee/Joy/pull/9)：截至 14:20 UTC 為 open draft，base `t1.9-github-pr`，head `965ef7341fb9c3b1f7072d6c55514f4fcda12d90`。Ubuntu、macOS、Windows CI 成功；[web E2E run 41846319550](https://github.com/jimmynycuee/Joy/actions/runs/41846319550) 失敗（6 tests passed、1 failed：建立 repo 後找不到 `Your tasks will appear here.`）。沒有正式 review、inline comment 或 discussion。PR 必須維持 draft；keychain／機密處理仍需 owner review。
13. [PR #44 — memory FTS row keys](https://github.com/jimmynycuee/Joy/pull/44)：open、非 draft，base `t0-foundation`，head `e10f3518`，目前 clean；該 head 三平台 CI 成功，沒有 review。修補 memory FTS row key 並排除敏感 memories；依記憶／敏感資料規則需 owner review。
14. [PR #47 — Plan v0.2](https://github.com/jimmynycuee/Joy/pull/47)：已合併至 `main`；合併 commit `ef9338c`，包含 v0.2 計畫與決策。
15. [PR #48 — STATUS refresh](https://github.com/jimmynycuee/Joy/pull/48)：已合併至 `main`；目前 main 為 `c311fe6`。該 PR 的舊 head CI 成功；最新 `main` 的 CI 請以上方 run 41840639086 為準。

## 歷史 owner review 待處理事項（2026-11-04 18:49 UTC 快照）

- 審核 [PR #53](https://github.com/jimmynycuee/Joy/pull/53) 的 T1.12 provider allowlist；目前沒有 owner review/approval。保持 draft，且在更新後的 head checks 通過前不視為完成。
- `packages/core` provider/model interface 與 `packages/secrets` keychain/secret handling 已由 #58 整合；依 #58 合併後 follow-up 仍需 owner review。#2 本身仍 open、與 `main` 衝突且無 owner approval，但其基礎內容已由 #58 整合。
- 審核 [PR #44](https://github.com/jimmynycuee/Joy/pull/44) 的 memory FTS／敏感記憶處理變更；目前無 owner review。
- [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 的 P1 UI 範圍已由 #58 整合；其 keychain／機密處理仍列為 owner review follow-up，不在本次 STATUS PR 中修改來源 PR。
- T0.4 仍依 `docs/PLAN.md` 保持未勾選；Codex 真實執行 fixture 尚缺，需在已登入電腦上錄製。Windows 原生行為、rate-limit 輸出與實際可用模型名稱也尚不可視為完成驗收；確認預設模型名稱前不要猜測或改寫 PLAN §3.3。

## 歷史下一步（截至 14:20 UTC；目前進度以上方「P1 狀態與依賴 PR 快照」為準）

1. 等待 #2 owner review；再依 #2 → #3 → #4 → #5 整理衝突與 base、完成必要 review，並以各新 head 的三平台 CI 驗證。不得繞過 #2 的 owner gate。
2. 合併整理 #28/#46 的重複修補為一個更新到最新 base 的 PR，跑完整 `pnpm check` 與 server regression；新 head 三平台 CI 通過後再處理 #37。
3. 等另一個 Session 更新 #9 的 head，重新核對修補與 PR 狀態；依序整合 #8/#9，涉及 keychain／機密的工作保持 draft 並等待 owner review。
4. 處理 #44 的 owner review gate；完成仍未完成的 P1 工作，包括 T1.12 repo provider allowlist 與 T1.13 `joy doctor`，依 PLAN 次序推進。
5. 只有所有 P1 程式碼都整合進 `main`，且 `main` 的 `pnpm check` 與三平台 CI 通過後，才解除 P2 hold。P2 決策已記錄在 PLAN（包括 T2.7 Codex `app-server`）；本次狀態更新不啟動任何 ticket。
