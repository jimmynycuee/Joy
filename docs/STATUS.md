# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04 13:41 UTC
- 目前階段：**P1 整合進 `main`**；`main` 為 `ef9338c`（已合併 PR #47 的計畫文件），目前尚無 P1 程式碼 PR 整合進 `main`。
- 計畫依據：`docs/PLAN.md` v0.2（PR #47 已合併）。T2.5 決策已定：額度用完先交接給另一家；只有兩家都沒額度才排隊；成本上限依 config 的 `budget` 設定。這些不是待決事項。
- 驗證：在 `main` 的 `ef9338c` 執行 `pnpm check` 通過（格式、lint、typecheck、5 tests）；同一 SHA 的 [main push CI run](https://github.com/jimmynycuee/Joy/actions/runs/41839404606) 中 Ubuntu、macOS、Windows 均成功。

## PR 鏈快照（2026-11-04 13:41 UTC）

「三平台 CI 綠」只代表列出的遠端 PR head；衝突解除、rebase 或推送後必須等新 head 的 CI。只有 `main` 上述 `ef9338c` 的檢查是本次合併後基線驗證。

1. [PR #2 — P0 foundation](https://github.com/jimmynycuee/Joy/pull/2)：open，base `main`，head `56895e83`，有衝突；三平台舊 head CI 綠。包含 `packages/core` 介面，需擁有者審核，且是基礎鏈的阻塞點。
2. [PR #3 — Claude Code provider](https://github.com/jimmynycuee/Joy/pull/3)：open，base `t0-foundation`，head `33b1b69c`，有衝突；三平台舊 head CI 綠。變更 `packages/core` provider interface，需擁有者審核。
3. [PR #19](https://github.com/jimmynycuee/Joy/pull/19)：open draft，base `main`，head 與 #3 相同，但目前與 `main` 衝突；三平台舊 head CI 綠。它是 #3 的重複 PR，不能用來繞過 #2 的 owner gate；保留 #3 作為依賴鏈後，關閉 #19。
4. [PR #4 — Git worktree executor](https://github.com/jimmynycuee/Joy/pull/4)：open，base `t1.1-claude-cli`，head `3e6cd927`，有衝突；三平台舊 head CI 綠。
5. [PR #5 — config](https://github.com/jimmynycuee/Joy/pull/5)：open，base `t1.4-worktree`，head `d13197c0`，目前無衝突；三平台 CI 綠。變更 `packages/core` provider interface，需擁有者審核；依賴 #4。
6. [PR #6](https://github.com/jimmynycuee/Joy/pull/6)、[#7](https://github.com/jimmynycuee/Joy/pull/7) 與 [#31](https://github.com/jimmynycuee/Joy/pull/31)：已合併到上游功能分支，但尚未進 `main`；#47 是文件變更，不包含這些 P1 程式碼。
7. [PR #33](https://github.com/jimmynycuee/Joy/pull/33)：open draft，base `t1.1-claude-cli`，head `6e9efcf4`，目前 clean、三平台 CI 綠；等待基礎鏈重整後再 rebase／review／驗證。
8. [PR #45](https://github.com/jimmynycuee/Joy/pull/45)：open draft，base `t1.11-config`，head `141e5e87`，目前 clean、三平台 CI 綠；等待依賴分支重整後再驗證。
9. [PR #28](https://github.com/jimmynycuee/Joy/pull/28) 與 [PR #46](https://github.com/jimmynycuee/Joy/pull/46)：同一分支、同一 head `0cd9f58a` 的 T1.6 Origin 驗證修補；#28 以 `t1.6-server` 為 base、#46 以 `main` 為 base，兩者現在都與 base 衝突。舊 head 三平台 CI 綠，不代表本機未發布的解衝突修補已驗證。應合成一份修補，更新到最新 base，只保留一個 PR，推送後等新 head CI。
10. [PR #37](https://github.com/jimmynycuee/Joy/pull/37)：open draft，base `fix/t1.6-origin-host-validation`，head `a4310d4a`，目前 clean、三平台 CI 綠；依賴 #28/#46 的修補分支，待其重整後更新 base 並重驗。
11. [PR #8](https://github.com/jimmynycuee/Joy/pull/8)：open draft，base `t1.7-event-log`，head `38c66421`，目前 clean、三平台 CI 綠。
12. [PR #9](https://github.com/jimmynycuee/Joy/pull/9)：open draft，base `t1.9-github-pr`，head `36605031`，目前 clean、三平台 CI 綠；目前 PR snapshot 無正式 review/comment/thread。仍需完成已列出的 review 修補：HTTP 與 WebSocket 同源驗證、keychain 不可用時 UI 降級、WebSocket 自動重連與快照後無重複補事件、排除不能改檔的 `openai-api`、CI 執行 web build 與 Playwright E2E、更新 PR 描述並列出 T2.1。完成後依序整合 #8、#9；敏感處理仍需 owner review。
13. [PR #44 — memory FTS row keys](https://github.com/jimmynycuee/Joy/pull/44)：open，base `t0-foundation`，head `e10f3518`，目前 clean、三平台 CI 綠；涉及記憶／敏感資料規則，需擁有者審核後才能合併。
14. [PR #47 — Plan v0.2](https://github.com/jimmynycuee/Joy/pull/47)：已合併進 `main`；merge commit 為 `ef9338c`，包含 `docs/PLAN.md` v0.2 與 T2.5 決策。合併後 main 的 CI 三平台全綠，本機 `pnpm check` 亦通過。

## 擁有者待處理

- 審核 [PR #2](https://github.com/jimmynycuee/Joy/pull/2)、[PR #3](https://github.com/jimmynycuee/Joy/pull/3)、[PR #5](https://github.com/jimmynycuee/Joy/pull/5) 的 `packages/core` 介面變更；依賴鏈在必要審核前不得合併。
- 審核 [PR #44](https://github.com/jimmynycuee/Joy/pull/44) 的 memory FTS／敏感記憶處理變更。
- [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 修完後，審核其中 keychain／機密處理部分；本次 snapshot 沒有正式 review，不能視為已核准。
- T0.4 Codex 真實 fixture 需要擁有者在已登入的電腦執行 `node scripts/record-fixtures.mjs codex`，再跑 `pnpm vitest run --project providers codex` 並移除合成 edit fixture；這不是本次 `pnpm check` 的一部分。
- 依 `docs/PLAN.md` §9 確認目前帳號可用的預設模型名稱；尚未確認前不要猜測或改寫預設值。

## 下一步（依使用者指定的整合順序）

1. 等 #2 的 owner review；依 #2 → #3 → #4 → #5 解衝突、更新 base 到 `main`、完成另一家模型 review 與新 head 三平台 CI，再按 owner gate 合併。同步處理與 #3 重複的 #19、以及依賴分支 #33/#45。
2. 將 #28/#46 合併成一份修補，rebase 到最新 base，跑完整 `pnpm check` 和 server regression；推送後等新 head 三平台 CI，再處理 #37。
3. 完成 #9 所有審查修補與 CI／PR 描述更新，再依序整合 #8、#9；涉及機密的部分須等 owner review。
4. 處理 #44 的 owner review gate；再完成 P1 剩餘 T1.12、T1.13。所有 P1 進 `main` 且 `main` 的 `pnpm check` 與三平台 CI 綠後，才依 PLAN 順序開始 P2（從 T2.2 起）。本狀態更新不啟動任何新 ticket。
