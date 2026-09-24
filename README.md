<div align="center">
  <img src="./docs/images/logo.png" width="100" alt="BrowserClaw Logo" />
  <h1>BrowserClaw</h1>
  <p><b>Control your everyday Chrome browser from AI agents, without losing logins or focus.</b></p>
  <p>
    <a href="./docs/MAP.md">Project Map</a> ·
    <a href="./docs/TOOLS.md">Tool Reference (49)</a> ·
    <a href="./AGENT_CONFIG_GUIDE.md">Client Config</a> ·
    <a href="./README.zh-CN.md">Chinese (zh-CN)</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserclaw/releases">Releases</a>
  </p>
</div>

---

<details>
<summary><b>Background: Why BrowserClaw?</b></summary>

<br/>

Browser automation frameworks that drive a separate browser instance (Playwright, Puppeteer, browser-use) start from a clean profile. They do not inherit your active logins, cookies, or extensions, and copying a live Chrome profile on Windows fails with file-sharing locks. Attaching to an existing Chrome via a debug port triggers security banners.

BrowserClaw takes a different route: a Chrome MV3 extension plus a local Native Messaging bridge, running inside the Chrome you already use. Cookies, sessions, and extensions are preserved, and automation happens in background tabs without stealing focus.

</details>

---

## ⚡ What is BrowserClaw?

BrowserClaw is a Chrome extension + local MCP server that lets AI agents operate your real browser. It exposes 49 tools across 7 categories (navigation, perception, action, observation, management, diagnostics, network), with a minimal 14-tool core profile for everyday sessions.

Two execution paths are available:

1. **Deterministic tools** – indexed clicks, fills, batch pipelines, form wizards, screenshots, network capture, etc. The calling agent plans each step.
2. **`chrome_act_toward_goal`** – a local perception-action micro-loop. The native server perceives the page, decides the next action, and acts, without a network round-trip per step. It uses TypeSafe Jev System One inference when an API key is set, and falls back to a built-in heuristic engine otherwise.

---

## 🧩 What this fork adds

This working copy is a fork of BrowserClaw, published at <https://github.com/MRsiyam16/webclaw>. The original project is preserved as the `upstream` git remote (`GoldenLoaf24h/browserclaw`) so future upstream fixes can still be pulled. The licence is unchanged: AGPL-3.0 at the repo root, MIT under `app/chrome-extension`.

Upstream is honest about _what it did_; this fork is built to be honest about _what actually happened_. Its merged-tool work makes every mutating action report its real outcome and shrinks what an agent has to read to find out.

- **Evidence envelope + verdicts.** Every mutating tool returns an `outcome` line, structured `evidence`, and `postConditions` (see `result-envelope.ts`). The `verdict` is one of `applied`, `applied_unverified`, `noop`, `failed`, `stale_ref`.
- **Post-conditions.** A tool declares what should be true after the action; each condition carries its expected value, the actual value, and evidence. Before it may report failure it runs a bounded settle-poll — 4 reads over 3 waits of 200 ms, capped at 600 ms — and stops early the moment the condition holds. Value assertions are evaluated against the PRE-navigation read-back, so an action whose effect is a URL change is checked against the value it committed, not the page it landed on.
- **Persistent element refs.** Beyond the positional `index`, elements carry a stable `ref` (`e1`, `e2`, …) backed by a `WeakRef` map with fingerprint self-healing. A dead ref returns `stale_ref` plus `recovery.freshRefs` — the page's current index — instead of a silent click on the wrong node.
- **Schema-typed extraction.** `browser_extract` reads declared fields from the page and returns `{data, missing, sourceRefs}`: absent values go in `missing` and are never invented. Arrays are supported, each value carries per-value provenance, and an unsupported schema shape returns a structured `error` rather than an empty result.
- **Token discipline.** Every response passes through an output budget (`budgetText`, default 120,000 chars) that truncates with an honest marker instead of silently. `read_dom` is delta-only by default (`deltaOnly: false` returns the full tree); an unchanged re-read measured 18,698 chars → 227. In compact format, consecutive near-duplicate list rows fold into a one-line SimHash marker that still enumerates every folded ref.
- **Set-of-Mark screenshots.** `browser_screenshot` can annotate interactive elements with numbered badges on one shared numbering scheme and returns an `elementMap` alongside `somLabels`. `zoom` crops around chosen label numbers and scales them up; an unknown label returns a structured error naming the valid numbers.
- **Tier-3 power tools.** `javascript` and `cdp_execute` can read `document.cookie` and drive arbitrary input, so they stay out of the default profile view. They are disclosed by `tool_docs(category:'power')` and only unlocked for the session when that call passes `activateForSession: true`.

### Measured, not claimed

4 tasks × 2 arms, one fresh session per cell, numbers read back from the local session DB. Correctness was 4/4 in both arms.

| Task                     | webclaw (calls / s / input tokens) | browser_exec (calls / s / input tokens) |
| ------------------------ | ---------------------------------- | --------------------------------------- |
| 40-row typed extraction  | 9 / 16.4 / 36,730                  | 19 / 111.2 / 46,751                     |
| Wikipedia search         | 13 / — / —                         | 14 / — / —                              |
| Multi-step click-through | 14 / 31.3 / —                      | 8 / 31 / —                              |
| Modal-overlay form       | 26 / 18.7 / —                      | 48 / 378 / —                            |

Read these with the usual caveats. The sample is 4 tasks × 2 arms — small. The prompts were not byte-identical in length, so **compare the call counts, not the token columns**. The exec arm's modal-overlay time (378 s) was inflated by its correct refusal of loopback URLs during that run, not by the form interaction itself.

### Verify it yourself

```bash
# from the repo root
pnpm --filter chrome-mcp-shared build        # rebuild packages/shared after editing it

cd app/chrome-extension
npx vitest run                               # full extension suite (76 files / 657 tests)
npx vue-tsc --noEmit                          # typecheck, must be clean
npm run build                                 # rebuild the extension bundle
```

One rule that costs people hours: after `npm run build`, the running extension still uses the OLD bundle. Reload it by POSTing `/reload-extension` to the local bridge, then confirm health at `/ping`.

### Known limits

- The benchmark sample is small (4 tasks × 2 arms) and the prompts differ in length — treat the call-count column as the trustworthy one.
- `tests/boost-dom-perception-and-execution-pipeline.test.ts` is timing-sensitive and can fail under parallel load; it passes on a re-run.
- `npm run build` can fail with `EBUSY` while Chrome holds `.output/chrome-mv3` — build elsewhere and mirror, and do not kill Chrome.
- `browser_exec` refuses loopback/private URLs by design; `file://` URLs and the extension's own tools are unaffected.
- Connection and execution issues are covered in [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

For an agent-facing handbook covering the repo map, build/test loop, and the rules a change must respect, see [AGENTS.md](./AGENTS.md). A self-contained visual write-up of the tool surface lives at [docs/webclaw.html](./docs/webclaw.html).

---

## 🎯 Key capabilities

- **Session continuity** – Runs inside your existing Chrome. Google, GitHub, and SSO logins are already there; no profile copying, no re-authentication.
- **Pruned, indexed DOM** – `chrome_read_dom` strips non-interactive and occluded nodes and assigns 1-based indices. On 1,000+ node pages this reduces node count by over 85% (test-validated), keeping snapshots small. A fast snapshot mode returns a viewport summary in ≤30 ms and ≤15 KB.
- **Card flattening and viewport virtualization** – `flattenCards` collapses repetitive feed cards into one-line summaries; `virtualizeViewport` folds off-screen list items into count placeholders.
- **Shadow DOM traversal** – Recursively walks open shadow roots; closed shadow hosts are tagged and interacted with at the host level. Accessible names are extracted from icon-only buttons (aria-label, title, SVG titles).
- **Batch pipelines** – `chrome_batch_actions` runs multi-step click/fill/wait/assert/extract sequences in a single MCP round-trip. `chrome_form_pipeline` advances multi-step forms locally.
- **Overlay dismissal** – `chrome_dismiss_overlay` closes marketing popups, cookie banners, and modals in one step, without dumping the DOM.
- **Delta piggybacking** – `includeDelta: true` returns DOM mutations in the same response as an action, removing the need for a follow-up DOM read.
- **Native event fidelity** – Clicks and keystrokes are dispatched as trusted CDP events (`isTrusted: true`), so React/Vue/Angular and Shadow DOM handlers fire normally.
- **Coordinate fallback** – When DOM indexing fails (canvas, WebGL, icon-only UI), a screenshot grid plus `chrome_computer` provides coordinate-based control with 24 px snap-to-edge.
- **Human handoff** – `chrome_request_human_intervention` dims the page, shows a banner, and parks the cursor so the user can complete 2FA or captchas; automation resumes afterward.
- **Tab and window management** – Create, group, move, and close tabs, query history and bookmarks, and capture performance traces, all under the user's existing credentials.

---

## 🧠 Dual-brain execution

```text
┌─ Macro Planner (your reasoning LLM) ───────────────────┐
│  Task decomposition, cross-page strategy, recovery     │
└───────────────────────────┬────────────────────────────┘
                            │ MCP (low frequency)
                            ▼
┌─ Semantic Micro-Loop (Native Server) ──────────────────┐
│  chrome_act_toward_goal:                               │
│  perceive → decide (Jev or heuristic) → act → verify   │
│  No MCP round-trip per step                            │
└───────────────────────────┬────────────────────────────┘
                            │ Native Messaging
                            ▼
┌─ Chrome MV3 Extension ─────────────────────────────────┐
│  48 deterministic tools · CDP events · in-page engine  │
└────────────────────────────────────────────────────────┘
```

Routing guideline:

- Fixed action sequence, known indices → deterministic tools (`chrome_batch_actions`, `chrome_form_pipeline`).
- Single-page goal in natural language → `chrome_act_toward_goal`.
- Long-horizon, multi-page, novel, or escalated situations → the calling agent drives.

The micro-loop is bounded: at most 60 steps in Jev mode (default 10), truncated to 5 steps in heuristic fallback. It intercepts 14 destructive action keywords (pay, delete, submit, etc.) and escalates ambiguous or low-confidence decisions back to the calling agent with candidate elements.

**Setup:** set the `TYPESAFE_API_KEY` environment variable to enable Jev inference. Without it, the micro-loop runs on the heuristic engine – always functional, slower, and more conservative.

---

## 🚀 Quick start

### Option 1: Prebuilt release (no build)

1. Download the latest `browserclaw-extension-v*.zip` and `browserclaw-skill-v*.zip` from [Releases](https://github.com/GoldenLoaf24h/browserclaw/releases/latest).
2. Unzip both to persistent local folders.
3. Open `chrome://extensions`, enable Developer mode, and load the extension folder.
4. Copy the `skill/` folder into your agent's skills directory.

### Option 2: Install with an AI agent

Paste this to your agent:

> "Set up BrowserClaw: https://github.com/GoldenLoaf24h/browserclaw. Read INSTALL.md and follow the steps."

Then load the extension from `app/chrome-extension/.output/chrome-mv3` into `chrome://extensions`.

### Option 3: Build from source

```bash
git clone https://github.com/GoldenLoaf24h/browserclaw.git
cd browserclaw && pnpm install && pnpm build
cd app/native-server && node dist/scripts/register-dev.js
```

Then load `app/chrome-extension/.output/chrome-mv3` into `chrome://extensions`.

Full onboarding (native host registration, MCP client setup, Jev key, health check) is in [INSTALL.md](./INSTALL.md).

---

## 🛠️ Tool catalog

All 49 tools are grouped below. For machine-readable schemas and parameter details, see [docs/TOOLS.md](./docs/TOOLS.md).

### Autonomous execution (1)

- **`chrome_act_toward_goal`** – Local perception-action loop toward a natural-language goal. Jev inference with heuristic fallback; escalates on ambiguity or destructive actions.

### Navigation & tabs (7)

- **`chrome_navigate`** – Open URL, refresh, history back/forward, background tabs.
- **`chrome_switch_tab`** – Switch active tab or bind session affinity.
- **`chrome_close_tabs`** – Close tabs by id, URL, or session (requires confirm for active tab).
- **`chrome_move_tab`** – Reposition tabs or move across windows.
- **`get_windows_and_tabs`** – List windows and tabs with state.
- **`chrome_attach_tab` / `chrome_detach_tab`** – Attach or detach the CDP debugger.

### Perception & extraction (6)

- **`chrome_read_dom`** – Indexed, pruned DOM tree with shadow DOM traversal and fast snapshot mode.
- **`chrome_grep`** – Regex or text search returning element indices without a full DOM dump.
- **`chrome_get_markdown`** – Clean Markdown extraction for reading tasks.
- **`chrome_inspect_media`** – Extract image or canvas data; super-resolves small captchas.
- **`chrome_get_dropdown_options`** – List select/combobox options.
- **`chrome_console`** – Capture console logs and errors.

### Action & pipeline (15)

- **`chrome_interact_index`** – Trusted click, hover, double-click, drag by 1-based index.
- **`chrome_fill_index`** – Trusted text input with clear, submit, and multiline support.
- **`chrome_batch_actions`** – Multi-step pipeline (click/fill/wait/assert/extract) in one round-trip.
- **`chrome_form_pipeline`** – Autonomous multi-step form filling.
- **`chrome_smart_scroll`** – Scroll page or inner containers with progress reporting.
- **`chrome_keyboard`** – Raw key presses and shortcuts.
- **`chrome_upload_file`** – Native file-input upload.
- **`chrome_insert_media`** – Paste/drop a real File into rich-text editors.
- **`chrome_handle_dialog`** – Accept or dismiss native alert/confirm/prompt.
- **`chrome_handle_download`** – Wait for and locate downloads.
- **`chrome_computer`** – Coordinate-level mouse/keyboard control (visual fallback).
- **`chrome_request_human_intervention`** – Yield to the user for captcha/2FA.
- **`chrome_undo_last_action`** – Roll back the last mutation.
- **`chrome_dismiss_overlay`** – Close popups, modals, and cookie banners.
- **`chrome_javascript`** – Evaluate JavaScript in the page context.

### Observation & diagnostics (3)

- **`chrome_screenshot`** – Viewport, element, or full-page capture with optional coordinate grid.
- **`chrome_cdp_execute`** – Raw CDP escape hatch.
- **`chrome_tool_docs`** – Query tool schemas and activate hidden profiles.

### Management (9)

- **`chrome_tab_group_create/update/list/ungroup/close`** – Tab group lifecycle.
- **`chrome_history`** – Search browsing history.
- **`chrome_bookmark_search/add/delete`** – Bookmark operations.

### Network (3)

- **`chrome_intercept_api`** – Capture backend JSON responses matching a URL pattern.
- **`chrome_network_capture`** – Record network traffic.
- **`chrome_network_request`** – Authenticated HTTP requests through the browser session.

### Performance & health (4)

- **`performance_start_trace / stop_trace / analyze_insight`** – Record and analyze performance traces.
- **`chrome_doctor`** – Check port, extension link, token, and native host health.

---

## 🏗️ Architecture

```text
AI Client (any MCP-capable agent)
         │  MCP over HTTP/SSE on 127.0.0.1:12306, or stdio
         ▼
Native Messaging Bridge (Fastify + Stdio Host)
         ├── Fast Decision Engine (Jev micro-loop)
         └── Passthrough for 48 deterministic tools (49 tools total)
         │  Chrome Native Messaging
         ▼
Chrome MV3 Extension (Service Worker)
         ├── In-Page Engine (1-based DOM indexing)
         ├── CDP Session Manager
         └── Agent Cursor Overlay
```

For details, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## 📚 Documentation

- [Project Map](./docs/MAP.md) – Navigation hub and reading paths.
- [Tool Reference](./docs/TOOLS.md) – Schemas for all 49 tools.
- [Install & Onboard](./INSTALL.md) – Step-by-step setup including Jev key.
- [Agent Integration](./AGENT_CONFIG_GUIDE.md) – MCP client configuration.
- [Architecture](./docs/ARCHITECTURE.md) – Design and decisions.
- [Troubleshooting](./docs/TROUBLESHOOTING.md) – Connection and execution issues.

---

## 💡 Acknowledgments

- [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) – MV3 extension and Native Messaging bridge foundation.
- [browser-use/browser-use](https://github.com/browser-use/browser-use) – DOM-first indexing principles.
- [BrowserOS](https://github.com/browseros-ai/BrowserOS) – DOM diffing and element grep patterns.
- [TypeSafe](https://docs.typesafe.ai) – Jev System One fast-decision models.

---

## 📄 License

[AGPL-3.0](./LICENSE). Modifications and SaaS deployments must remain open-source.

---

BrowserClaw is an independent Chrome extension and MCP automation project. It is not affiliated with the standalone `browserclaw` package on npm.
