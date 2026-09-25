# Multi-browser routing

BrowserClaw tool calls accept an optional `browserId` (`chrome` or `edge`). Omit it to retain legacy Chrome routing. Chrome uses the existing endpoint (`127.0.0.1:12306`); Edge uses `127.0.0.1:12307`. Configure endpoints independently with `BROWSERCLAW_CHROME_MCP_URL` and `BROWSERCLAW_EDGE_MCP_URL` (or plugin `native_server_port` / `edge_server_port`). `BROWSERCLAW_MCP_URL` remains the legacy Chrome endpoint override.

Routing is per call. Browser sessions, tier activation, tokens, and tab affinity are kept separate by browser identity. If the selected browser endpoint is unavailable or identifies itself as another browser, the call fails closed; it never falls back to the other browser. The selected browser identity is included additively in successful responses.

## Deployment and verification

The active Hermes plugin and both browser unpacked-extension directories are deployed. Chrome's native host listens on `127.0.0.1:12306`; Edge's browser-specific wrapper sets `WEBCLAW_BROWSER_ID=edge` and listens on `127.0.0.1:12307`. Each `/ping` response includes its own `browserId` and port. The popup reports connected only when native messaging status and the matching browser ping both agree.

Live checks navigated separate Chrome and Edge windows to local pages with unique browser markers, read each DOM through its own MCP endpoint, then reloaded Chrome and Edge separately and confirmed the other browser's marker remained readable. Evidence and pre-deployment backups are in `%LOCALAPPDATA%/hermes/cache/scratch/webclaw-multibrowser-evidence.json` and `webclaw-multibrowser-backup-*`.

The installed plugin schemas declare `browserId`. If a running Hermes process cached the old tool schemas before deployment, restart that Hermes process once so it reloads the installed plugin schema. No Hermes core files need to be changed.
