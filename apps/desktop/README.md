# Joy Desktop

The Tauri 2 shell adds a native system tray, launch-at-login control, task-completion notifications, and signed updater support around the existing Joy web interface.

## Development

Install the monorepo dependencies, start the Joy server on loopback port `4317`, then run:

```sh
pnpm --filter @joy/desktop dev
```

In development, the embedded UI uses Vite and its existing `/api` and `/ws` proxy. The desktop notification watcher polls `GET http://127.0.0.1:4317/api/tasks` every three seconds and reports transitions from an active task to `done`, `failed`, `review_ready`, or `cancelled`. It sends generic notification text only, only while the main window is hidden, and can be disabled from the tray. The Joy server remains bound to loopback; the desktop app does not widen its listener.

Closing the main window hides it in the tray. Use **Open Joy** to restore it, **Launch at login** to toggle OS autostart (login launches start hidden), **Task notifications** to toggle alerts, **Check for updates** to install a signed update and restart Joy, or **Quit Joy** to exit.

The server process is not bundled or started by this ticket. Also, the packaged static web UI still uses same-origin API paths; wiring production web assets to the separate loopback server remains unverified and requires a desktop-specific bridge. The tray watcher itself reads the loopback task API directly.

## Updater release configuration

The updater plugin and tray check/install flow are included, but release updates are intentionally not configured in this repository. Before building a distributable release, the owner must provide and set:

- The HTTPS update-manifest endpoint(s) and the corresponding public signing key in `src-tauri/tauri.conf.json` under `plugins.updater`.
- The matching private signing key, and optional password, through `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the release environment. Keep the private key outside the repository and never commit it.

Tauri update signatures are mandatory. Do not enable insecure HTTP transport or generate a replacement key for an existing release channel; losing or changing the signing key prevents existing installs from receiving updates. `bundle.createUpdaterArtifacts` is enabled, so unsigned/local bundling is not a release validation. The owner-provided endpoint and matching signing material are required to verify update delivery end to end.
