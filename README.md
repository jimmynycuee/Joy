# Joy

> Claude 與 GPT 分工寫程式的本機平台，前面再加一個個人助理。

- **兩家分工**：交叉審查、平行競賽、`ask_peer` 互相諮詢
- **每個角色自由選模型**：OpenAI API、Claude Code（訂閱）、Codex（訂閱）
- **Codex 風格介面**：任務清單、即時 agent 紀錄、diff、一鍵開 PR
- **跑在你自己的電腦上**，用你自己登入的訂閱，不另外花錢

完整計畫與 ticket：[`docs/PLAN.md`](docs/PLAN.md)。目前進度：[`docs/STATUS.md`](docs/STATUS.md)。給 AI agent 的開發守則：[`AGENTS.md`](AGENTS.md)。

## 安裝（約 10 分鐘）

需要：

| 工具                                                        | 用途                         | 檢查                          |
| ----------------------------------------------------------- | ---------------------------- | ----------------------------- |
| Node.js 22.13 以上                                          | 執行 Joy                     | `node --version`              |
| pnpm 10（`corepack enable` 即可）                           | 安裝套件                     | `pnpm --version`              |
| Git                                                         | 每個任務在獨立 worktree 進行 | `git --version`               |
| [Claude Code](https://docs.anthropic.com/claude-code)，登入 | 實作或審查（用你的訂閱）     | `claude --version`            |
| [Codex CLI](https://github.com/openai/codex)，登入          | 實作或審查（用你的訂閱）     | `codex --version`             |
| GitHub CLI，登入（選用）                                    | 開 draft PR、issue 轉任務    | `gh auth status`              |
| OpenAI API key（選用）                                      | 助理大腦、背景工作           | 在 Joy 設定頁填入，存進鑰匙圈 |

至少要有 Claude Code 或 Codex 其中一個；兩個都有才能交叉審查。

```bash
git clone https://github.com/jimmynycuee/Joy.git
```

```bash
cd Joy
```

```bash
pnpm install
```

```bash
pnpm joy doctor
```

`doctor` 會逐項檢查並告訴你怎麼修；`untested` 代表能用但版本或狀態沒驗證過（見[疑難排解](#疑難排解)）。

## 啟動

開兩個終端機，都在 Joy 資料夾裡：

```bash
pnpm joy start
```

```bash
pnpm web
```

然後打開 <http://localhost:5173>。`Ctrl+C` 停止。Joy 只聽 `127.0.0.1`，其他裝置連不到。

## 第一次設定

1. **Settings**：確認各角色用哪個模型。預設實作者 Claude Code、審查者 Codex；只裝了一家就兩個都設成那一家（會提示不是跨模型審查）。測試時用最便宜的模型（Claude `haiku`、Codex `gpt-6-luna`）、effort 選 low。
2. （選用）**OpenAI API key**：設定頁輸入，存在作業系統鑰匙圈，不會寫進設定檔或資料庫。每月預設上限 30 美元（`budget.openai_api_usd_monthly_cap`）。
3. **Add a repository**：填入本機 git repo 的路徑與預設分支。可限制這個 repo 只用哪幾家（敏感程式碼只給一家看）。

## 第一個任務

1. **Create a task**：選 repo，寫下要做的事，Workflow 選「Implement + review」。
2. 中間欄即時顯示 agent 的動作；右側是 diff。需要你同意的動作（🔴，例如推送、刪除、網路）會跳出核准。
3. 結束後：審查通過顯示 done；審查還有意見則停在 review_ready 讓你決定。
4. 滿意就按 **Open draft PR**（第一次要填 GitHub repo URL），worktree 會自動清掉；不要就按 **Discard worktree**。

## 日常使用

- **助理**（Assistant 頁）：問任務狀態、請它開任務（「幫 joy repo 修 README 錯字」）、設提醒與定時工作（「每個工作日 9 點提醒我看 PR」）、搜尋以前的對話。它記得你親口說過的偏好，左側可以看、改、刪；每則回覆下方會標出用到哪些記憶。
- **平行競賽**：Workflow 選 Compete，兩家同時做，各自被對方審一次，裁判比較；你選一個，或請裁判合併。
- **GitHub issue**：在有設 GitHub remote 的 repo 給 issue 加上 `joy` label，幾分鐘內變成任務；issue 內容一律當外部資料，它要求的動作都要你核准。也可以對助理說「do #123」。
- **Stats**：各模型的通過率、審查找到的問題數、耗時、交接次數。
- **Settings → Worktrees**：磁碟用量與閒置的 worktree；有未推送 commit 的會再問一次。
- **備份**：每天自動備份資料庫到 `~/.joy/backups`（保留 7 份）；設定頁可立即備份、匯出 JSON。還原時先停 Joy，再：

```bash
pnpm joy restore 2026-11-06
```

## 不信任的程式碼：container 模式

新增 repo 時勾選「run agents in a container」，這個 repo 的 agent 會在 Docker 裡跑，只看得到該任務的 worktree 與 repo 的 git 資料，看不到你的家目錄、其他專案與主機上的登入。需要 Docker（Docker Desktop 請開啟 host networking），第一次先：

```bash
pnpm joy container-build
```

```bash
pnpm joy container-login claude
```

Codex 要在 container 裡用，`~/.joy/config.yaml` 的 `providers.codex.transport` 要設成 `exec`。網路沒有隔離（CLI 要連模型與 Joy 的審核），保護的是檔案。

## 自訂工作流程

除了三種內建流程（Single agent、Implement + review、Compete），可以在 `~/.joy/config.yaml` 定義自己的組合，建立任務時就能在 Workflow 裡選：

```yaml
workflows:
  careful:
    description: 先規劃、Codex 實作、Claude 審查最多 5 輪
    pattern: review_loop
    roles:
      implementer: { provider: codex-cli, model: gpt-6.1-sol }
      reviewer: { provider: claude-cli, model: opus }
    max_rounds: 5
    plan_first: true
```

`pattern` 可用 `single`、`review_loop`、`compete`；沒寫的角色用 Settings 裡的設定。

## Google 行事曆與 Gmail（選用）

Joy 透過 [Google Workspace MCP server](https://github.com/taylorwilsdon/google_workspace_mcp) 讀寫你的行事曆與信件，登入資料由那個 server 存在你的電腦，Joy 不經手。

1. 在 Google Cloud 建一個 OAuth 用戶端（類型 Desktop app），依該 server 的說明設定環境變數。
2. 安裝 [uv](https://docs.astral.sh/uv/)，執行一次 `uvx workspace-mcp --tools gmail calendar` 完成登入。
3. 在 `~/.joy/config.yaml` 加上，然後重啟 Joy：

```yaml
mcp_servers:
  google:
    command: uvx
    args: [workspace-mcp, --tools, gmail, calendar]
```

助理讀信、查行事曆會直接做；替你新增自己的行程會在對話裡告訴你；**寄信、邀請別人一律等你在助理頁按 Approve**。讀過信之後同一輪要做的任何更動也都要你核准。

## 從手機或其他電腦使用（Tailscale，預設關閉）

Joy 預設只聽 `127.0.0.1`。要從手機或另一台電腦用：

1. 兩台裝置都裝 [Tailscale](https://tailscale.com) 並登入同一個帳號；在跑 Joy 的電腦上用 `tailscale ip -4` 查到它的 IP（`100.x.y.z`）。
2. 建好網頁：`pnpm --filter @joy/web build`（Joy 會直接提供這份網頁）。
3. 在 `~/.joy/config.yaml` 加上，然後重啟 Joy：

```yaml
remote:
  enabled: true
  address: 100.x.y.z
  port: 4317
```

4. 在另一台裝置開 `http://100.x.y.z:4317`，貼上跑 Joy 那台電腦的 `~/.joy/api-token`。

每個請求都要帶 token，沒帶或錯的一律 401。手機遺失或 token 外洩時，到 Settings → Access token 按 **Regenerate**：舊 token 立刻失效、所有連線斷開，其他裝置要貼新的 token。`address` 請填 Tailscale IP，不要填區網 IP（`0.0.0.0`、`::` 會被拒絕）；Tailscale 之外的流量是明文 HTTP。

**手機要裝成 App、收推播，需要 HTTPS**。用 `tailscale serve` 把 Joy 包成 HTTPS（這條路不需要上面的 `remote.enabled`）：

```bash
tailscale serve --bg 4317
```

再把它給的網址主機名（例如 `my-pc.tail-1234.ts.net`）加進設定，重啟 Joy，手機開 `https://my-pc.tail-1234.ts.net`：

```yaml
remote:
  https_hosts: [my-pc.tail-1234.ts.net]
```

## 疑難排解

| 狀況                          | 處理                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `doctor` 顯示 CLI `missing`   | 安裝該 CLI，或在 `~/.joy/config.yaml` 的 `providers.claude.command`／`providers.codex.command` 指定路徑 |
| CLI 版本 `untested`           | 能用，但輸出格式可能變了；有問題時照 [`docs/cli-versions.md`](docs/cli-versions.md) 重錄 fixture        |
| 任務卡在 queued，提示額度用完 | 訂閱額度到上限；Joy 會在重設後接續，或依 `fallback.on_rate_limit` 交給另一家                            |
| 任務停在 awaiting_approval    | 到核准中心處理；逾時預設暫停（`approvals.on_timeout`），之後核准仍會以同一個 session 接續               |
| 網頁顯示 401                  | 先啟動 `pnpm joy start` 再啟動 `pnpm web`（`pnpm web` 讀取 server 建立的 token）                        |
| `restore` 說 Joy is running   | 先停掉 `pnpm joy start` 再還原                                                                          |
| 其他問題                      | Settings → Debug logs 下載當天的 log（已移除已知的 secret）附在 issue 裡                                |

資料都在 `~/.joy`（可用絕對路徑的 `JOY_HOME` 改位置）：`config.yaml`、`joy.sqlite`、`worktrees/`、`backups/`、`logs/`、`api-token`。

## 隱私：資料會送去哪裡

- 交叉審查、`ask_peer`、額度交接、平行競賽都會把程式碼送給**另一家**。敏感 repo 用允許清單限制只用一家。
- 助理大腦與背景工作（記憶擷取、對話摘要）預設走 OpenAI API：對話內容會送到 OpenAI。記憶只取你親口說的話，密碼、證件號碼、健康與財務資訊會被擋下。
- Joy 不讀取、不保存、不轉送 Claude／ChatGPT 的訂閱登入憑證；CLI 用的是你自己登入的帳號。API key 與 bot token 只存在鑰匙圈，log、事件與匯出都會先經過遮罩。
- 不收集使用統計。

## 開發

```bash
pnpm check
```

本機 API 認證：Joy 首次啟動時在 `${JOY_HOME:-~/.joy}/api-token` 建立隨機 token（POSIX 為 `0600`；Windows 依賴使用者目錄的 ACL）。`pnpm web` 的 Vite 開發伺服器從同一位置讀取並注入 token，所以 server 與 Vite 都只綁 loopback，不要把開發埠公開；token 不防禦同機其他帳號或程序。要輪替就停掉兩者、刪除 token 檔，再先啟動 server、後啟動 Vite。

## 授權

[Business Source License 1.1](LICENSE)：原始碼公開，可自由閱讀、修改、個人與公司內部使用；不得作為託管服務與本專案的付費版本競爭。
每個版本發佈 4 年後自動轉為 Apache License 2.0。這不是 OSI 定義的開源授權。
