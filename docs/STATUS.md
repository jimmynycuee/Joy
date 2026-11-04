# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04 14:52 UTC
- 目前階段：**P1 整合進 `main`**；目前 live `main` 為 `2c3fdb4`（PR #51 僅更新狀態快照）。PR #47（Plan v0.2）與 PR #48（STATUS 更新）已合併；目前沒有 P1 程式碼 PR 合併進 `main`，因此不可標示 P1 完成。
- 計畫與決策：依 `docs/PLAN.md` v0.2。已定案 Codex 在 P2 以 `app-server` 取代 `exec --json`（T2.7）、每個 repo 的 provider 允許清單（T1.12）、`joy doctor`（T1.13），以及額度用完先交接給另一家、兩家都無額度才排隊、成本上限依 config `budget`。決策已確定不代表 tickets 已完成；T1.12、T1.13 仍未完成。P1 順序依 PLAN §10：T1.6 + T1.7 → T1.12 → T1.9 → T1.13 → T1.8。
- 驗證基線：`main` 的 [CI run 41840639086](https://github.com/jimmynycuee/Joy/actions/runs/41840639086) 對 SHA `c311fe6ff6bb535151c7775d5e4728696feee02d` 成功，Ubuntu、macOS、Windows 皆通過。

## PR 鏈快照（2026-11-04 14:20 UTC）

各 PR 的 CI 狀態只代表下列當時讀到的 head；解衝突、rebase 或推送後，必須以新 head 的 CI 為準。只有上述 `main` SHA 的檢查是目前合併後基線。

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

## PR #2 base 更新（2026-11-04 14:52 UTC）

- PR #2 已將 live `main` SHA `2c3fdb4ca7924cd52dea62321d037a83e01766ab` 合併進原有分支；衝突僅涉及 `docs/PLAN.md` 與 `docs/STATUS.md`，`packages/core` 沒有語意衝突。舊 head 的檢查不能代替新 head 的驗證；`packages/core` 介面的 owner review 仍是必要 gate，不得繞過。

## 擁有者待處理

- 審核 [PR #2](https://github.com/jimmynycuee/Joy/pull/2)、[#3](https://github.com/jimmynycuee/Joy/pull/3)、[#5](https://github.com/jimmynycuee/Joy/pull/5) 的 `packages/core` 介面變更；#2 與 live `main` 的衝突已解決，但 owner review 仍是基礎鏈的必要 gate。
- 審核 [PR #44](https://github.com/jimmynycuee/Joy/pull/44) 的 memory FTS／敏感記憶處理變更。
- [PR #9](https://github.com/jimmynycuee/Joy/pull/9) 的後續修補發布後，仍須由 owner 審核 keychain／機密處理；保持 draft。
- T0.4 仍依 `docs/PLAN.md` 保持未勾選：2026-11-04 在已登入 ChatGPT 的 Mac 錄製了真實 edit / MCP / resume fixtures，且 `-c` MCP 注入已在 `exec` 模式實測成功。raw fixture contract test 驗證錄製事件，不驗證 provider adapter mapping；Windows 原生行為、rate-limit 輸出與實際可用模型名稱仍未確認。確認預設模型名稱前不要猜測或改寫 PLAN §3.3。

## 下一步（依 `docs/PLAN.md` 的 P1 順序）

1. #2 已將 live `main` 合入原有分支；驗證新 head 並等待 owner review，再依 #2 → #3 → #4 → #5 整理 base、完成必要 review，並以各新 head 的三平台 CI 驗證。不得繞過 #2 的 owner gate。
2. 合併整理 #28/#46 的重複修補為一個更新到最新 base 的 PR，跑完整 `pnpm check` 與 server regression；新 head 三平台 CI 通過後再處理 #37。
3. 等另一個 Session 更新 #9 的 head，重新核對修補與 PR 狀態；依序整合 #8/#9，涉及 keychain／機密的工作保持 draft 並等待 owner review。
4. 處理 #44 的 owner review gate；完成仍未完成的 P1 工作，包括 T1.12 repo provider allowlist 與 T1.13 `joy doctor`，依 PLAN 次序推進。
5. 只有所有 P1 程式碼都整合進 `main`，且 `main` 的 `pnpm check` 與三平台 CI 通過後，才解除 P2 hold。P2 決策已記錄在 PLAN（包括 T2.7 Codex `app-server`）；本次狀態更新不啟動任何 ticket。
