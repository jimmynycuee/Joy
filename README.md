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

狀態：P0（地基）進行中，還不能使用。
