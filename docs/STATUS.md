# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04 15:06 UTC
- 目前階段：**P1 整合進 `main`**；最新 `main` 為 `2c3fdb4ca7924cd52dea62321d037a83e01766ab`。PR #47、#48、#51 均已合併；#51 是 STATUS 文件更新，P1 程式碼尚未由下列開啟中的 PR 整合。
- 計畫與決策：依 `docs/PLAN.md` v0.2。P1 順序為 T1.6 + T1.7 → T1.12 → T1.9 → T1.13 → T1.8。已定案 Codex 在 P2 以 `app-server` 取代 `exec --json`（T2.7）、每個 repo 的 provider 允許清單（T1.12）、`joy doctor`（T1.13），以及額度用完先交接給另一家、兩家都無額度才排隊、成本上限依 config `budget`。決策已定不代表 ticket 已完成。
- `main` CI 基線：[run 41848131509](https://github.com/jimmynycuee/Joy/actions/runs/41848131509) 對 SHA `2c3fdb4ca7924cd52dea62321d037a83e01766ab` 成功；Ubuntu、macOS、Windows jobs 皆成功。此快照沒有在該 SHA 上另行執行 `pnpm check`。

## PR 鏈快照（2026-11-04 15:06 UTC）

以下是現有 P1 依賴鏈及相關 P1 PR 的 GitHub 即時狀態。CI 描述只適用於列出的 head；push、rebase 或解衝突後，必須以新 head 的 checks 為準。沒有 check 的 PR 不視為通過；queued checks 仍未完成。

1. [PR #2 — P0 foundation](https://github.com/jimmynycuee/Joy/pull/2)：open、非 draft，base `main`，head `8de3b7ab`，與 base 衝突；GitHub 未為此衝突 head 啟動 checks。沒有正式 review（0）；有一則討論要求 owner review。此 PR 涉及 `packages/core` 介面，依 `AGENTS.md` 需 owner review。
2. [PR #3 — Claude Code provider](https://github.com/jimmynycuee/Joy/pull/3)：open、非 draft，base `t0-foundation`，head `33b1b69c`，與 base 衝突；Ubuntu、macOS、Windows checks 均成功。沒有正式 review（0）；討論中要求 owner review。涉及 `packages/core` provider 介面。
3. [PR #4 — Git worktree executor](https://github.com/jimmynycuee/Joy/pull/4)：open、非 draft，base `t1.1-claude-cli`，head `3e6cd927`，與 base 衝突；該 head 的三平台 checks 均成功；沒有正式 review（0）。
4. [PR #5 — config](https://github.com/jimmynycuee/Joy/pull/5)：open、非 draft，base `t1.4-worktree`，head `d13197c0`，merge state clean；該 head 的三平台 checks 均成功；沒有正式 review（0）。變更包含 `ModelRef` 的 optional `effort` 欄位，仍需依 `AGENTS.md` 完成 core 介面 owner review。
5. [PR #19](https://github.com/jimmynycuee/Joy/pull/19)：open draft，base `main`，head 與 #3 相同（`33b1b69c`），與 base 衝突；該 head 的三平台 checks 均成功；沒有正式 review（0）。討論中有 bot 訊息指出這是意外重複並提及當時無法關閉；PR 目前仍 open。
6. [PR #28](https://github.com/jimmynycuee/Joy/pull/28) 與 [PR #46](https://github.com/jimmynycuee/Joy/pull/46)：同一 head `0cd9f58a`。#28 base `t1.6-server`、#46 base `main`，兩者均與 base 衝突；該 head 的 Ubuntu、macOS、Windows checks 均成功；兩者皆無正式 review（0）。
7. [PR #33 — OpenAI Responses API provider](https://github.com/jimmynycuee/Joy/pull/33)：open draft，base `t1.1-claude-cli`，head `6e9efcf4`，merge state clean；三平台 checks 均成功；沒有正式 review（0）。
8. [PR #37 — non-editing provider guard](https://github.com/jimmynycuee/Joy/pull/37)：open draft，base `fix/t1.6-origin-host-validation`，head `a4310d4a`，merge state clean；三平台 checks 均成功；沒有正式 review（0）。
9. [PR #44 — memory FTS row keys](https://github.com/jimmynycuee/Joy/pull/44)：open、非 draft，base `t0-foundation`，head `e10f3518`，merge state clean；三平台 checks 均成功；已請求 owner `jimmynycuee` review，但目前沒有正式 review（0）。變更涉及記憶／敏感資料處理。
10. [PR #45 — effort validation](https://github.com/jimmynycuee/Joy/pull/45)：open draft，base `t1.11-config`，head `141e5e87`，merge state clean；三平台 checks 均成功；沒有正式 review（0）。
11. [PR #8](https://github.com/jimmynycuee/Joy/pull/8) 與 [PR #54](https://github.com/jimmynycuee/Joy/pull/54)：head 相同（`8a9a6b47`），但 base 不同。#8 為 draft、base `t1.7-event-log`、目前無衝突；#54 非 draft、base `main`，與 base 衝突。兩者 head 的 Ubuntu check 成功、Windows check 失敗、macOS check 仍 queued；沒有正式 review（0）。
12. [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 與 [PR #50](https://github.com/jimmynycuee/Joy/pull/50)：head 相同（`27c3de79`），但 base 不同。#9 為 draft、base `t1.9-github-pr`、目前無衝突；#50 非 draft、base `main`，與 base 衝突。該 head 的 web E2E、Ubuntu 與 Windows checks 成功，macOS check 仍 queued。#9 已請求 owner `jimmynycuee` review；兩 PR 均沒有正式 review（0）、inline review comment 或討論。
13. [PR #53 — T1.12 provider allowlist](https://github.com/jimmynycuee/Joy/pull/53)：open draft，base `t1.7-event-log`，head `ab669338`，目前無衝突；Ubuntu 與 Windows checks 成功，macOS check 仍 queued；沒有正式 review（0）。
14. [PR #47 — PLAN v0.2](https://github.com/jimmynycuee/Joy/pull/47)、[#48 — STATUS refresh](https://github.com/jimmynycuee/Joy/pull/48) 與 [#51 — STATUS refresh](https://github.com/jimmynycuee/Joy/pull/51)：均已合併。最新 `main` 是 #51 後的 `2c3fdb4`；該 SHA 的三平台 CI 狀態見上方 run 41848131509。

## 擁有者待處理

- Review [PR #2](https://github.com/jimmynycuee/Joy/pull/2)、[#3](https://github.com/jimmynycuee/Joy/pull/3) 的 `packages/core` 介面變更；#2 目前衝突且無 checks，是依賴鏈阻塞點。PR #5 的 `ModelRef` 介面變更也需 owner review。
- Review [PR #44](https://github.com/jimmynycuee/Joy/pull/44) 的 memory FTS／敏感記憶處理變更；目前已請求 owner review，尚無正式 review。
- [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 已請求 owner review；keychain／機密處理部分仍須 owner review。維持 draft。
- PR #8/#54 的 Windows check 失敗、macOS check 尚未完成；PR #9/#50 與 #53 的 macOS check 尚未完成。以上結果僅代表各自列出的 head。
- T0.4 仍依 `docs/PLAN.md` 保持未勾選；Codex 的 Windows 原生行為、rate-limit 輸出與實際可用模型名稱仍未由現有驗收確認。確認預設模型名稱前，不要猜測或改寫 PLAN §3.3。

## 下一步（依 `docs/PLAN.md` 的 P1 順序）

1. 依 #2 → #3 → #4 → #5 整理依賴分支與衝突，完成必要 owner review，並以各新 head 的三平台 CI 驗證；不得繞過 #2 的 owner gate。
2. 整理 #28/#46 的相同修補與 base 衝突，選定可整合的 PR 並在新 head 重跑 checks；之後再處理依賴它的 #37。
3. 釐清 #8/#54、#9/#50 的相同 head 與不同 base；先處理失敗／queued checks，再依序整合 T1.9 與 T1.8。涉及 keychain／機密的工作維持 draft 並等待 owner review。
4. 依 PLAN 順序推進 T1.12（#53）、T1.13 `joy doctor` 與其餘 P1 工作；處理 #44 的 owner review gate。
5. 只有所有 P1 程式碼整合進 `main`，且 `main` 的 `pnpm check` 與三平台 CI 通過後，才解除 P2 hold。本次狀態更新不啟動任何 ticket。
