# AGENTS.md

A hands-on handbook for AI agents working in the **webclaw** fork of BrowserClaw (`C:/Users/MRsiy/Projects/browserclaw`). Read this before touching code — it assumes you know nothing about the repo beyond what's on this page.

This is a fork: `origin` is `MRsiyam16/webclaw`, `upstream` is `GoldenLoaf24h/browserclaw`. Never push to `upstream`.

---

## 1. Repo map

| Path | What it is |
| --- | --- |
| `app/chrome-extension/` | The MV3 Chrome extension. Tool implementations live in `entrypoints/background/tools/browser/*.ts` (one file per tool or tool family: `read-dom.ts`, `interact-index.ts`, `extract-tool.ts`, `screenshot.ts`, `result-envelope.ts`, …). `in-page-engine.ts` is the injected page-side engine (runs in the page, does DOM indexing/refs). Tests live in `app/chrome-extension/tests/`. |
| `app/native-server/` | The Native Messaging bridge (Fastify). Serves the tools over HTTP + MCP (`/mcp`) on `127.0.0.1:12306`. Package name `mcp-chrome-bridge`. |
| `packages/shared/src/` | The **declared** tool schemas. `tools.ts` holds `TOOL_SCHEMAS` + `TOOL_DEFINITIONS`; `tool-profiles.ts` holds `TOOL_CATEGORIES` and the tier/profile mapping. Package name `chrome-mcp-shared` — must be built before the extension or tests see changes here. |
| `plugins/browserclaw/` | The Hermes plugin: `core_schemas.json` (tool schema JSON), `plugin.yaml` (`provides_tools`), `__init__.py` (`TOOL_DEFINITIONS`). |
| `test/` | Root-level e2e harness (`test/e2e/runner.ts`, tiered fixtures). Run with `pnpm test` from the root. |
| `docs/` | Human docs: `TOOLS.md`, `ARCHITECTURE.md`, `MAP.md`, `TROUBLESHOOTING.md`, and `webclaw.html` (visual write-up). |

---

## 2. Build & test

Each command's working directory matters.

```bash
# From the REPO ROOT — rebuild packages/shared (MANDATORY after editing packages/shared/src)
pnpm --filter chrome-mcp-shared build

# From app/chrome-extension — the full extension test suite
cd app/chrome-extension
npx vitest run                  # 76 files / 657 tests, must be green
npx vue-tsc --noEmit            # typecheck, must be clean

# From app/chrome-extension — rebuild the extension bundle
npm run build                   # output lands in .output/chrome-mv3
```

**The dist trap:** the extension and the tests import `packages/shared` from its **built `dist/`**. If you edit `packages/shared/src/tools.ts` (or any shared source) and skip `pnpm --filter chrome-mcp-shared build`, both the extension and the test suite keep seeing the OLD schemas and your change silently does nothing.

---

## 3. The golden workflow for a change

1. **TDD — write the failing test first.** Add or extend a test in `app/chrome-extension/tests/` that fails for the reason you're fixing, then make it pass.
2. **Keep the whole suite green** (76 files / 657 tests). One known flaky test: `tests/boost-dom-perception-and-execution-pipeline.test.ts` is timing-sensitive and can fail under parallel load; re-run it on its own before treating a failure as real.
3. **Typecheck clean:** `npx vue-tsc --noEmit` reports nothing.
4. **One logical commit.** See §8 for git discipline. Then verify the new code is actually live — §4.

---

## 4. A rebuild is not live code

The most expensive lesson in this repo: after `npm run build`, the **running** Chrome service worker keeps the OLD bundle. The extension does not pick up new code until you tell the bridge to reload it.

```bash
curl -X POST http://127.0.0.1:12306/reload-extension \
  -H "x-mcp-token: $(cat ~/.chrome-mcp/bridge-token)"
# wait ~10s for the service worker to restart, then:
curl http://127.0.0.1:12306/ping
```

Prove the new code is live by a marker **only the new bundle emits** (a new response field, a new log line, a changed string). A green `ping` only proves the bridge is up — it says nothing about which bundle the service worker is running.

---

## 5. Declaring a new tool or param

A tool argument must be declared in **all** of these places, or it will be silently stripped:

1. `packages/shared/src/tools.ts` — the schema (`TOOL_SCHEMAS`, and `TOOL_DEFINITIONS` where the profile/category mapping needs it).
2. The Hermes plugin — mirror the change in `plugins/browserclaw/core_schemas.json`, `plugins/browserclaw/plugin.yaml` (`provides_tools`), and `plugins/browserclaw/__init__.py` (`TOOL_DEFINITIONS`).
3. The **installed** copy under `%LOCALAPPDATA%/hermes/plugins/browserclaw/`.

Hermes validates tool arguments against the registered schema and **silently strips undeclared params**, so a param that's missing from the plugin copy disappears without error. There is a parity test, `tests/tool-surface-parity.test.ts`, that exists precisely to catch this — keep it green.

---

## 6. Invariants that must never break

- **Additive response fields only.** Callers depend on existing field *names*; add new fields, never rename or repurpose old ones.
- **Never write attributes to the host DOM.** The index/ref maps are isolated by design — do not stamp data attributes onto the page's real elements.
- **Refs match `/^e\d+$/` and are never recycled.** A ref is stable identity.
- **`index` is POSITIONAL (current view); `ref` is stable identity.** Always prefer `ref`; use `index` only for a same-view click.
- **Default output budget is 120,000 chars** (`budgetText`); truncation must emit the honest marker, never silently drop content.
- **The verdict vocabulary is fixed:** `applied` | `applied_unverified` | `noop` | `failed` | `stale_ref`. Don't invent new verdicts.

---

## 7. Talking to the live browser

The bridge listens on `http://127.0.0.1:12306`.

- `GET /ping` — health, no token needed.
- `POST /mcp` — JSON-RPC. Requires:
  - the `x-mcp-token` header, whose value is in `~/.chrome-mcp/bridge-token`;
  - an `Accept: application/json, text/event-stream` header;
  - echoing the `mcp-session-id` header returned by the `initialize` handshake (a request without it returns an error telling you to initialize first).
- **Tier-gated tools need activation first.** Categories like `perceive` and `power` are disclosed but not callable until you run `tool_docs(category: '<cat>', activateForSession: true)`. Tier-3 `power` (`javascript`, `cdp_execute`) stays locked until explicitly activated for the session.
- **Always pass an explicit `tabId`.** Acting on an unspecified tab is refused by design — do not rely on a default tab.

---

## 8. Git discipline for parallel agents

- **Stage only the paths you changed.** Never `git add -A` (or `-a`) — other agents may be working in the same tree.
- **Never amend or rebase another agent's commits.**
- **Verify your own commit:** `git show --stat HEAD` — confirm it lists exactly the files you intended and nothing else.
- **Commitlint rejects sentence-case subjects** (`@commitlint/config-conventional` via the husky `commit-msg` hook). Use a conventional lowercase subject. If a mandated subject is rejected by the hook, re-commit with `git commit --no-verify`.
- Disable parallel test runs while committing if you hit `index.lock`; on `index.lock`, sleep 2s and retry (up to 5 times).

---

## 9. Environment gotchas

- **Windows + git-bash.** Use POSIX shell syntax; MSYS path conversion is disabled for native tools, so pass `C:/...` forward-slash paths to `node`, `git`, etc.
- **`npm run build` can fail with `EBUSY`** while Chrome holds `.output/chrome-mv3`. Build elsewhere and mirror the result — **never kill Chrome**.
- **Loopback/private URLs are refused by `browser_exec`** by design (a sandbox guard). Use a `file://` URL or the extension's own tools instead — the extension itself is fine with loopback URLs.
- The extension's unpacked path (what you load into `chrome://extensions`) is `app/chrome-extension/.output/chrome-mv3`.

---

## 10. Where the honest limits are

Do not restate the project's limits here — see the README's **"Known limits"** and **"Measured, not claimed"** sections, plus `docs/TROUBLESHOOTING.md` for connection/execution issues. The benchmark sample is small and the prompts were not byte-identical, so the call-count column is the trustworthy one.