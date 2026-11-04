# Google Workspace read adapter boundary

`@joy/google-workspace` defines a typed, runtime-validated port for the T3.8 read-only slice: list calendars, free/busy, list/get calendar events, and search/read Gmail messages and threads. Its connector accepts only Joy-owned read operation identifiers; it does not define or assume names for a third-party MCP server's tools.

The package intentionally does not create an MCP client, perform OAuth, load credentials, register assistant tools, or make network calls. Joy currently has no app-facing outbound MCP client/configuration or Google OAuth/token lifecycle. A runtime integration must supply a supported transport/connector and explicit read-only credentials/scopes before this port can be wired into the assistant. Tests use synthetic connector responses only.

There are no write operations in this contract. Gmail draft/send, event creation/update/deletion, and invitations remain deferred until the T2.3 owner policy and explicit workflow approval are in place.
