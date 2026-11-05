# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-05 04:43 UTC
- 目前階段：**P1 尚未完成；P2 依計畫順序暫停。** PR #67 已合併，四項 checks 全通過，並更新 `docs/PLAN.md`、`docs/STATUS.md`。T1.12 的 PR #53 已關閉但未合併；T1.12 仍未完成。此回合重新核對 #53、#57、#62、#67；其餘 PR 狀態未刷新，以下較早快照已明確標記為歷史資料。

## 歷史狀態摘要（2026-11-05 03:31 UTC；已被後續快照取代）

- 當時 `main` 記錄為 `ceebdc5c0117ed4b9bb2f25e126ed045651eb9d1`；PR #62 的 head `f5602ffa02b85c23c470b421668d6c0b8fedc6fb` 有四項 checks 通過，仍 open/draft、無衝突、無正式 review。此快照已被更新狀態取代，不能用作目前 PR #62 狀態。
- 當時主線驗證（較早快照）：以 `main` `f78453731340de2276001fc1c978f7e758166177` 為基底、含文件變更的工作樹，身份隔離的 `pnpm check` 通過（196 tests passed、2 skipped）；該次 main CI run `41897323588` 成功。
- 該快照記錄 T1.6/T1.7 已整合、PR #58 包含 T1.9 publisher 與 T1.8 UI 主體；真實測試 repo 與首頁 T1.13 驗收仍未完成。

## 最新狀態更新（GitHub 即時核對：2026-11-05 04:43 UTC）

- **PR #67：** 已合併，Ubuntu、macOS、Windows 與 web E2E 四項 checks 全部通過；合併內容包含 `docs/PLAN.md`、`docs/STATUS.md`。
- **T1.12 / PR #53：** 於 04:35:56 UTC 關閉、未合併；head `5ed6c322b81869edcd551268e10b1a6c6ecb2c0e` 的四項 checks 均通過。關閉不代表程式碼已進入 `main`，T1.12 維持未勾選、未完成。
- **T1.13 / T1.8 的 PR #62：** open/draft，head `e5ce95745cb239d4c349b4c7c49a7f7b369b5c78`，base `main`、無衝突；Ubuntu、macOS、Windows、web E2E 四項 checks 全通過，無正式 review 或留言。
- **共用 head 的 PR #57：** 仍 open、非 draft，base `main`，與目前 base 衝突；與已關閉的 #53 共用 head `5ed6c322`。不要將 #53 的 CI 結果視為 #57 可合併，也不要在未確認共享分支安全前向該 head 發布。
- **下一步：** T1.12 仍需在安全的分支／PR 路徑上完成並重新驗證，且遵守必要 owner review；P1 未完成前維持 P2 暫停。本次沒有修改任何產品程式碼或 PR。

## 先前即時狀態快照（GitHub PR 快照：2026-11-05 04:14 UTC；已被上方最新狀態取代）

> 以下內容記錄 04:14 UTC 時的狀態；其中 PR #53、#62 等狀態已變更，不可當作目前即時狀態。

**主線：** [PR #64](https://github.com/jimmynycuee/Joy/pull/64) 已合併；本 checkout 的 `origin/main` 為 `a0c7627`，PR #64 的四項 checks 均通過。未另行確認合併後 `main` 的 CI。

### P1 尚未完成；P2 依計畫順序暫停

1. **T1.12 / PR #53：** open/draft，base `t1.7-event-log`，head `5ed6c322b81869edcd551268e10b1a6c6ecb2c0e`，無衝突；Ubuntu、macOS、Windows、web E2E 四項 checks 全通過。owner `jimmynycuee` 已列為 requested reviewer，尚無正式 review/approval。較新的 bot 留言聲稱曾把 base 改為 `main`，但 live PR 欄位仍是 `t1.7-event-log`，故以欄位快照為準。此前獨立 review 指出 resume allowlist 拒絕時機、無法更新 allowlist 的錯誤指引、資料庫值結構驗證及非活動 role/未建立 attempt 狀態處理等待驗證事項；四項 CI 綠不等於這些事項已解除。
2. **重複 PR #57：** open、非 draft，與 #53 共用 head `5ed6c322`，base `main` 且與當時的 main 衝突；四項 checks 全通過，無正式 review。保持開啟，不發布到共享 head 或關閉它。
3. **T1.13 / T1.8 的 PR #62：** open/draft、base `main`、head `348593b25a601f5f88f2b07e959ec40be855e5d0`；當時與 `main` 衝突，最新 head 沒有 checks，也沒有正式 review 或留言。#62 的功能尚未整合；T1.13/T1.8 維持未勾選，且該次更新未修改 #62。
4. **publisher / T1.9 與 Web UI PR：** [#8](https://github.com/jimmynycuee/Joy/pull/8) open/draft、base `t1.7-event-log`、head `fbdb1a4e453653739d377426d003c77d021bf5f1`，三平台 checks 通過，無 review/comment。[#9](https://github.com/jimmynycuee/Joy/pull/9) open/draft、base `t1.9-github-pr`、head `5ce4e977c456de255686a496eddc3d1ce70c3b47`，無衝突，四項 checks 全通過，無 review/comment。T1.9 仍需依 PLAN 在安全指定的真實測試 repo 驗收，尚不可勾選。#66 是同 head 指向 `main` 的重複 PR；當時 open/draft、與 main 衝突，四項 checks 通過，未修改它。
5. **其他 owner review：** [#44](https://github.com/jimmynycuee/Joy/pull/44) open、非 draft、clean，三平台 checks 全通過，已請求 owner review、尚無正式 review。[#2](https://github.com/jimmynycuee/Joy/pull/2) open、非 draft、與 main 衝突且當時無 checks；留言要求 owner review `packages/core` 介面。`packages/secrets` keychain/secret-handling 的 owner review 亦仍是後續事項。
6. **T0.4 Codex fixture：** 合成 fixture 不能替代真實錄製。先前記錄為 Cloud 無 Codex CLI、唯一列出的 Mac 離線；該阻塞當時未重新檢查。

### T4.2 部分進度（未完成驗收）

[PR #17](https://github.com/jimmynycuee/Joy/pull/17) 提供本機可安裝 PWA 基礎，仍 open/draft，base `t1.8-web`、head `ad4539dacbe87cb5088891afd6a972e32add6a86`，無衝突、無正式 review。Ubuntu、macOS、Windows 與 web E2E 四項 checks 全通過。PR 描述限定本機 PWA，Web Push／遠端存取待 T4.1，T4.2 驗收條件仍未完成。工作階段回報本機 `pnpm check` 為 223 passed/2 skipped、web build 通過及 E2E 9/9；但 PR 說明列的是 183 passed/2 skipped、E2E 5/5，數字不一致，需在更新 PR 描述或宣告完成前核實。該次更新未重跑這些命令，也未修改 PR #17。

## 先前快照中的下一步（04:14 UTC；已被最新狀態取代）

1. 完成 #53 待處理的 T1.12 修正／驗證並取得必要 owner review；遵守共享 head 限制，保留 #57 開啟。
2. 按 PLAN 在安全指定的測試 repo 實際驗收 T1.9 draft PR 建立；fake `gh`／local bare remote 測試不足以勾選。
3. #62 當時與 main 衝突、沒有最新 head checks；等待既定 owner 流程處理，保持 draft 且不修改該 PR。T1.13/T1.8 只有在整合到 main 並完成驗收後才可勾選。
4. 完成仍待處理的 T0.4 真實 Codex fixture 和必要 owner reviews；驗證 P1 前維持 P2 hold。P4 的 #17 僅代表部分進度，不能代替 P1 完成或 Web Push 驗收。

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
