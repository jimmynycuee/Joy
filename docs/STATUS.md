# Joy 目前狀態

> 接手前請先讀本檔、`AGENTS.md` 與 `docs/PLAN.md`。本檔記錄目前進度、阻塞與決策；ticket 勾選狀態以 `docs/PLAN.md` 為準。

- 最後更新：2026-11-04
- 目前階段：**P1 整合中**；基礎 PR 與多條後續分支尚未合併。
- 進度順序：`T1.6 + T1.7 → T1.12 → T1.9 → T1.13 → T1.8`（依 `docs/PLAN.md` §10）。
- 狀態快照：2026-11-04 查核 GitHub PR #2、#3、#4、#8、#9、#19、#28、#37、#44、#46、#47。

## 分支與 PR 快照

1. [PR #2 — P0 foundation](https://github.com/jimmynycuee/Joy/pull/2)：open，三平台 CI 通過；`packages/core` 介面需要擁有者審核。此 PR 是基礎分支，擁有者審核前依賴它的 base chain 不能前進。
2. [PR #3 — Claude Code provider](https://github.com/jimmynycuee/Joy/pull/3) 與 [PR #4 — Git worktree executor](https://github.com/jimmynycuee/Joy/pull/4)：兩者均 open、三平台 CI 通過；#3 與 `t0-foundation` 衝突，#4 與 `t1.1-claude-cli` 衝突，需先解決各自的 base 衝突才能合併。
3. [PR #19](https://github.com/jimmynycuee/Joy/pull/19)：open draft，head SHA 與 #3 相同，是 #3 的重複 PR（#19 以 `main` 為 base；#3 以 `t0-foundation` 為 base）。
4. [PR #28](https://github.com/jimmynycuee/Joy/pull/28) 與 [PR #46](https://github.com/jimmynycuee/Joy/pull/46)：head SHA 相同，都是 T1.6 Origin 驗證修正；#28 以 `t1.6-server` 為 base 且有衝突，#46 以 `main` 為 base 且目前無衝突。兩者皆 open，三平台 CI 通過。
5. [PR #37](https://github.com/jimmynycuee/Joy/pull/37)：open draft，以 #28 的 `fix/t1.6-origin-host-validation` 分支為 base；依賴該修正分支，三平台 CI 通過。
6. [PR #8 — GitHub draft PR publishing](https://github.com/jimmynycuee/Joy/pull/8) 與 [PR #9 — Web UI](https://github.com/jimmynycuee/Joy/pull/9)：兩者均 open draft、三平台 CI 通過且目前無 base 衝突；#9 以 #8 的 `t1.9-github-pr` 為 base。依本次工作交接，#9 的 review 修正仍待處理；GitHub 快照未顯示 review、comment 或 thread。
7. [PR #44 — memory FTS row keys](https://github.com/jimmynycuee/Joy/pull/44)：open，三平台 CI 通過且目前無 base 衝突；擁有者已被指定為 reviewer，仍需擁有者審核。
8. [PR #47 — Plan v0.2 docs](https://github.com/jimmynycuee/Joy/pull/47)：open，base 為 `main`，無衝突；本分支目前包含 `docs/PLAN.md` 與 `docs/STATUS.md`。PR 描述仍稱 STATUS 未變、進度清單可能落後；本 Session 的 PR 工具拒絕修改外部建立 PR 的描述，須由原作者更新。

## 擁有者待處理

- 審核 PR #2 的 `packages/core` 介面；這是基礎依賴鏈的阻塞點。
- 審核 PR #44（目前已指定擁有者為 reviewer）。
- 完成 PR #9 的 review 修正，再決定是否可結束 draft review（本次 GitHub 快照沒有列出具體 review 意見）。
- 更新 PR #47 描述：目前仍稱 `docs/STATUS.md` 未變，且進度清單可能落後；本 Session 無權修改此 PR 的描述，須由原作者處理。
- 確認實際可用的 Claude 與 Codex 模型名稱；尚未確認前不得猜測或改寫 `docs/PLAN.md` §3.3 的模型名稱。
- T0.4 尚待驗證 Codex 的 Windows 原生行為與 rate-limit 輸出；真實模型名稱也仍待擁有者確認。

## 已確認決策

- 額度用完時先把工作交接給另一家；只有兩家都沒有額度時才排隊等待恢復。
- 成本上限依設定檔 `budget` 欄位（包括 `budget.per_task.max_api_usd`）；這兩項均已在 `docs/PLAN.md` v0.2 定案，不是待決事項。
- Codex P1 使用 `exec --json`，P2 改用 `app-server`（見 T2.7）。

## 下一步

- 等待 PR #2 的擁有者審核；依序解決 #3/#4 的 base 衝突與目前記錄的重複/相依分支問題。
- PR #8/#9 保持 draft；先完成 #9 review 修正。PR #44 等擁有者審核。
- 按 `docs/PLAN.md` §10 的 P1 順序繼續；本快照不啟動 P2 以上 ticket。
