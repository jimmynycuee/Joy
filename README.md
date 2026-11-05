# Joy

> Claude 與 GPT 分工寫程式的本機平台，前面再加一個個人助理。

- **兩家分工**：交叉審查、平行競賽、`ask_peer` 互相諮詢
- **每個角色自由選模型**：OpenAI API、Claude Code（訂閱）、Codex（訂閱）
- **Codex 風格介面**：任務清單、即時 agent 紀錄、diff、一鍵開 PR
- **跑在你自己的電腦上**，用你自己登入的訂閱，不另外花錢

完整計畫與 ticket：[`docs/PLAN.md`](docs/PLAN.md)。給 AI agent 的開發守則：[`AGENTS.md`](AGENTS.md)。

## 開發

需要 Node 22 以上與 pnpm 10。

```sh
pnpm install
pnpm check
```

### 本機 API 認證

Joy 首次啟動時會在 `${JOY_HOME:-~/.joy}/api-token` 建立隨機 API token；若設定 `JOY_HOME`，請使用絕對路徑。POSIX 系統使用 owner-only `0600` 權限，Windows 依賴目前使用者目錄的 ACL。Vite 開發伺服器從同一位置讀取 token；若要輪替，先停止 server 與 Vite，刪除 token 檔，再先啟動 server、後啟動 Vite。開發版 UI bundle 需要攜帶 token，因此本機 server／Vite 維持 loopback，不要把開發埠公開給其他裝置；token 不防禦同機其他帳號或程序，只適用單一使用者的本機開發。production build 與 `vite preview` 不注入 token。

狀態：P0（地基）進行中，還不能使用。

## 授權

[Business Source License 1.1](LICENSE)：原始碼公開，可自由閱讀、修改、個人與公司內部使用；不得作為託管服務與本專案的付費版本競爭。
每個版本發佈 4 年後自動轉為 Apache License 2.0。這不是 OSI 定義的開源授權。
