# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04 18:49 UTC
- 目前階段：**P1 整合後續**；`main` 最新 tip 為 `59eb6b9f60d714b6208afd3e6d89af24dd200e9c`（PR #58 合併）。#58 已合併，但 P1 的 T1.12、T1.13 尚未完成；P2 仍 hold，T2.1 不在 #58 範圍。
- 計畫與決策：依 `docs/PLAN.md` v0.2。Codex 在 P2 使用 `app-server`（T2.7）、每 repo provider allowlist（T1.12）、`joy doctor`（T1.13）及額度／成本政策已定案；決策不代表 tickets 已完成。PR #53 是 T1.12 待處理項；T1.13 尚無對應開啟中的 PR。
- 合併後 `main` CI：[run 41889004890](https://github.com/jimmynycuee/Joy/actions/runs/41889004890) 對 SHA `59eb6b9f60d714b6208afd3e6d89af24dd200e9c` 已完成且成功：Ubuntu、macOS、Windows checks 與 web E2E 全部成功。

## P1 與 GitHub 快照（2026-11-04 18:49 UTC）

- [PR #58 — Integrate the P1 stack into main](https://github.com/jimmynycuee/Joy/pull/58)：已合併；PR head `8383dd80f5a5168d1db59728810e5bb91730e4da` 的 Ubuntu、macOS、Windows 與 web E2E checks 均成功。其描述列出 T1.6/T1.7、T1.8、T1.9 與相關修補為已整合或取代範圍；T2.1 明確排除。合併後 `main` 的 CI 仍以本節所列 run 41889004890 為準。
- PR #58 的說明列出已納入或取代的來源 PR：#2–#9、#19、#28/#46、#33、#37、#45、#50/#54；#53 的 T1.12 與 T1.13 是後續 P1 工作，不在 #58 範圍。
- PR #58 的 PR 描述記錄：`pnpm check` 成功（196 tests passed、2 skipped）、web build 成功、4 個 Playwright E2E 通過；其 exact-head Actions run 41887998301 的四個 jobs 皆成功。這些結果只適用該 PR head，不取代合併後 `main` SHA 的 CI run。
- PR #58 的正式 review 記錄為 0。依 `AGENTS.md`，`packages/core` provider/model interfaces 與 `packages/secrets` secret handling 的 owner review 仍須追蹤；PR #58 描述將其列為合併後 follow-up。
- [PR #53 — T1.12 provider allowlist](https://github.com/jimmynycuee/Joy/pull/53)：open draft，base `t1.7-event-log`，head `3fd90219695c34bb38d37539158c765853208c21`，GitHub merge state clean；Ubuntu、macOS、Windows checks 均成功，正式 review 為 0。它仍未合併到 `main`，且依 PLAN §7.3 仍需 owner review。
- [PR #57 — T1.12 provider allowlist](https://github.com/jimmynycuee/Joy/pull/57)：open、非 draft，與 #53 同一 head `3fd90219695c34bb38d37539158c765853208c21`，但 base 為 `main`；此讀取的 merge state 為 unknown、沒有 conflict 訊息，正式 review 為 0，三平台 checks 均成功。討論中記錄它是同一 T1.12 工作的意外重複 PR；本次未修改它。
- #8/#54（T1.9）仍 open 且同一 head `604c3b2a`；#8 為 draft、base `t1.7-event-log`，#54 非 draft、base `main`。其 Ubuntu、Windows checks 成功，macOS check cancelled。#9 仍為 open draft、head `27c3de79`、base `t1.9-github-pr` 並與該 base 衝突；該 head 的 Ubuntu、macOS、Windows 與 web E2E checks 成功。PR #58 描述列出 #8/#54/#9 的 P1 工作為已整合或取代；以上舊 PR checks 不代表合併後 `main` 的狀態。
- **下一步**：將 #53 對齊合併後的 `main`，在新 head 重驗並完成 owner review；完成 T1.13 `joy doctor` 後，且合併後 `main` 的 CI 通過，才解除 P2 hold。T0.4 真實 Codex fixture 仍依 PLAN 保持未勾選；Windows 真機行為、rate-limit 輸出與實際模型名稱不視為已驗收。

## PR 鏈快照（2026-11-04 14:20 UTC；歷史狀態）

各 PR 的 CI 狀態只代表下列當時讀到的 head；解衝突、rebase 或推送後，必須以新 head 的 CI 為準。本節是 14:20 UTC 的歷史快照；目前 `main` SHA 的檢查狀態見上方，該 run 已成功。

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

## Owner 與外部待辦（2026-11-04 18:49 UTC）

- PR #58 的正式 review 為 0；依 `AGENTS.md`，仍須 owner review `packages/core` provider/model interfaces 與 `packages/secrets` secret handling。PR #58 描述將此列為合併後 follow-up。
- PR #53 的正式 review 為 0；T1.12 repo provider allowlist 依 PLAN §7.3 仍需 owner review。
- T0.4 仍依 `docs/PLAN.md` 保持未勾選；Codex 真實 fixture 尚缺。Windows 原生行為、rate-limit 輸出與實際可用模型名稱仍未由現有驗收確認；確認模型名稱前不要猜測或改寫 PLAN §3.3。

## 歷史下一步（截至 14:20 UTC；目前進度以上方「P1 與 GitHub 快照」為準）

1. 等待 #2 owner review；再依 #2 → #3 → #4 → #5 整理衝突與 base、完成必要 review，並以各新 head 的三平台 CI 驗證。不得繞過 #2 的 owner gate。
2. 合併整理 #28/#46 的重複修補為一個更新到最新 base 的 PR，跑完整 `pnpm check` 與 server regression；新 head 三平台 CI 通過後再處理 #37。
3. 等另一個 Session 更新 #9 的 head，重新核對修補與 PR 狀態；依序整合 #8/#9，涉及 keychain／機密的工作保持 draft 並等待 owner review。
4. 處理 #44 的 owner review gate；完成仍未完成的 P1 工作，包括 T1.12 repo provider allowlist 與 T1.13 `joy doctor`，依 PLAN 次序推進。
5. 只有所有 P1 程式碼都整合進 `main`，且 `main` 的 `pnpm check` 與三平台 CI 通過後，才解除 P2 hold。P2 決策已記錄在 PLAN（包括 T2.7 Codex `app-server`）；本次狀態更新不啟動任何 ticket。
