# 遠端存取（T4.1）

Joy server 永遠只綁定 `127.0.0.1`；不要把它改綁 `0.0.0.0`，也不要用路由器埠轉送、公開反向代理或 Tailscale Funnel。遠端存取是明確 opt-in：先為 server 設定 bearer token，再以 Tailscale Serve 分享 loopback 服務。Serve 僅供 tailnet 使用，並遵守 tailnet ACL；它不是公開 ingress。

## 設定 bearer token

在啟動 Joy server 的程序環境中設定 `JOY_REMOTE_ACCESS_TOKEN`。產生至少 64 個 URL-safe 字元的隨機值；以下命令將 32 bytes 隨機資料直接放入環境變數，不會輸出 token：

macOS / Linux：

```sh
export JOY_REMOTE_ACCESS_TOKEN="$(openssl rand -hex 32)"
```

Windows PowerShell：

```powershell
$env:JOY_REMOTE_ACCESS_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

必須在這個環境中啟動或重啟 Joy server。Token 僅在程序記憶體中使用；不要放進 `config.yaml`、SQLite、事件、日誌、URL、`.env` 或命令列參數。未設定 token 時，HTTP 與 WebSocket 維持本機開發相容性；空值或格式不合規的設定會讓 server 啟動失敗，不會退回較寬鬆模式。

設定 token 後，所有 HTTP 路徑（包括 health）都要求：

```http
Authorization: Bearer <token>
```

WebSocket `/ws` 同樣要求 bearer 驗證。原生 WebSocket client 可送 `Authorization` header；能設定 WebSocket subprotocol 的瀏覽器 client 可送 `joy.v1` 與 `joy-bearer.<token>`。Server 只會回選 `joy.v1`，不會把 token 回傳。**不要**把 token 放到 query string。

## 以 Tailscale Serve 分享

先確認 tailnet HTTPS 憑證與 ACL 已設定，再把 Joy server 的 loopback port 分享給 tailnet。以下 `4317` 是目前 Web 開發代理使用的 server port；若你的 server 使用不同 port，替換成它實際監聽的 port：

```sh
tailscale serve --bg http://127.0.0.1:4317
tailscale serve status
```

Tailscale 會提供僅限 tailnet 存取的 HTTPS URL。需要停止分享時執行：

```sh
tailscale serve off
```

參考：[Tailscale Serve](https://tailscale.com/kb/1312/serve) 與 [Serve CLI](https://tailscale.com/kb/1242/tailscale-serve)。不要改用 `tailscale funnel`；Funnel 會將服務公開到網際網路。

## 範圍與限制

這項 server ticket 只增加 API 與 WebSocket bearer 驗證及 Tailscale 指引，刻意不修改 `apps/web`。目前 Web UI 尚未提供 token 輸入或附加 bearer header；因此不能宣稱已能透過 Tailscale 使用登入後的完整 Web UI。可設定 bearer header 的 HTTP / WebSocket client 可以使用受保護的 server API。Tailscale Serve 與實際 tailnet ACL 也未在此測試分支上驗證。
