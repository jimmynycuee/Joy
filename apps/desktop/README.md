# Joy Desktop

The Tauri 2 shell adds a native system tray, launch-at-login control, task-completion notifications, and signed updater support around the existing Joy web interface.

## Development

Install the monorepo dependencies, then run:

```sh
pnpm --filter @joy/desktop dev
```

Tauri starts the web UI through Vite on `127.0.0.1:5173` and refuses to attach to another process if that port is occupied. In development, the UI uses its existing `/api` and `/ws` proxy, and the desktop notification watcher polls `GET http://127.0.0.1:4317/api/tasks` every three seconds. The watcher reports transitions into `done`, `failed`, `review_ready`, or `cancelled` while the main window is hidden, and can be disabled from the tray.

The repository currently has no Joy server CLI or root start command: `createJoyServer().listen(port = 0)` is a programmatic API that binds to an ephemeral port by default. The Vite proxy and desktop notification watcher currently expect a compatible server on loopback port `4317`; starting that server and wiring its stable endpoint are not included in T4.3, so API-backed UI calls and desktop task notifications will not work unless an external launcher starts it on that port. The server remains loopback-only; the desktop app does not widen its listener.

Closing the main window hides it in the tray. Use **Open Joy** to restore it, **Launch at login** to toggle OS autostart (login launches start hidden), **Task notifications** to toggle alerts, **Check for updates** to install a signed update and restart Joy, or **Quit Joy** to exit.

The server process is not bundled or started by this ticket. Also, the packaged static web UI still uses same-origin API paths; wiring production web assets to the separate loopback server remains unverified and requires a desktop-specific bridge. The tray watcher itself reads the loopback task API directly.

## Updater release configuration

The updater plugin and tray check/install flow are included, but release updates are intentionally not configured in this repository. Before building a distributable release, the owner must provide and set:

- The HTTPS update-manifest endpoint(s) and the corresponding public signing key in `src-tauri/tauri.conf.json` under `plugins.updater`.
- The matching private signing key, and optional password, through `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the release environment. Keep the private key outside the repository and never commit it.

Tauri update signatures are mandatory, and `requireSignedVersion` is a supported updater setting that remains enabled to bind the artifact signature to its announced version. Do not enable insecure HTTP transport or generate a replacement key for an existing release channel; losing or changing the signing key prevents existing installs from receiving updates. `bundle.createUpdaterArtifacts` is enabled, so unsigned/local bundling is not a release validation. The owner-provided endpoint and matching signing material are required to verify update delivery end to end. The desktop package exposes native bundling as `pnpm --filter @joy/desktop tauri:build`; it intentionally does not define a `build` script so the root `pnpm build` does not invoke Rust or require release signing material.
